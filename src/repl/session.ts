import { runTurn, splitForCompaction, summarize } from "../core/engine.ts";
import type { Client, Tool, ToolRunner } from "../core/engine.ts";
import type { Message, Result, ViseError } from "../core/errors.ts";
import { formatContext, formatModelList } from "../output/format.ts";

/**
 * The outcome of a handled line. A successful turn carries the model's reply
 * and, when auto-compaction failed before the turn, an optional
 * `compactionWarning` the edge surfaces on stderr. This keeps all I/O at the
 * edge (invariant #2): the session never writes to stdout or stderr itself.
 */
export type LineResult =
  | "exit"
  | { ok: true; value: string; compactionWarning?: ViseError }
  | { ok: false; error: ViseError };

/**
 * Source of context-window data. Provided by the edge: the used count comes
 * from the server's own `usage.prompt_tokens` on the last chat call, and the
 * max comes from the server's live `/slots` report. The session only displays
 * it. This is an authoritative server count, not a local estimate.
 */
export interface ContextSource {
  /**
   * The server's token count of the most recent prompt sent (how full the
   * context is after the last turn). `undefined` until the first successful
   * chat returns a usage block.
   */
  lastPromptTokensUsed(): number | undefined;
  /** The model's maximum context window in tokens, queried live. */
  contextMax(): Promise<Result<number>>;
}

/**
 * Controller for inspecting and switching the active model.
 */
export interface ModelController {
  /** Return the currently active model identifier. */
  getModel(): string;
  /** Set the active model identifier. */
  setModel(name: string): void;
  /** Retrieve available model names from the server. */
  listModels(): Promise<Result<string[]>>;
}

/**
 * Auto-compaction triggers when the last turn's server-reported token count
 * reaches this fraction of the model's context window. Chosen high enough that
 * a normal turn only compacts when overflow is genuinely imminent.
 */
const COMPACTION_THRESHOLD = 0.9;

/**
 * How many complete turns (starting from a user message) to keep verbatim after
 * compaction, in addition to the summary. Keeps enough recent context that the
 * conversation continues to feel continuous.
 */
const RECENT_TURNS_TO_KEEP = 2;

/**
 * Owns the conversation state (the growing messages array) and handles
 * per-line turns. Stateless with respect to I/O: it takes the transport
 * types, context source, and working directory from the edge and never
 * touches process, stdin, or stdout itself.
 */
export class Session {
  private readonly messages: Message[];
  private readonly client: Client;
  private readonly tools: ToolRunner;
  private readonly toolDefs: Tool[];
  private readonly context: ContextSource;
  private readonly modelController?: ModelController;

  constructor(
    client: Client,
    tools: ToolRunner,
    toolDefs: Tool[],
    context: ContextSource,
    cwd: string,
    modelController?: ModelController,
  ) {
    this.client = client;
    this.tools = tools;
    this.toolDefs = toolDefs;
    this.context = context;
    this.modelController = modelController;
    this.messages = [{ role: "system", content: `Working directory: ${cwd}` }];
  }

  /**
   * Handle a single non-empty line. Returns "exit" when the line is `/exit`;
   * a formatted context line for `/context`; a compaction note for `/compact`;
   * otherwise the turn outcome. An auto-compact that fails before a turn does
   * not abort the turn — the user's prompt still runs against the uncut
   * conversation — and the failure is carried as `compactionWarning` on the
   * successful result so the edge can surface it (the session performs no I/O).
   */
  async handleLine(line: string): Promise<LineResult> {
    const trimmed = line.trim();
    if (trimmed === "/exit") return "exit";
    if (trimmed === "/context") return this.reportContext();
    if (trimmed === "/compact") return this.compact();
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      return this.handleModelCommand(trimmed);
    }
    this.messages.push({ role: "user", content: line });
    const auto = await this.maybeAutoCompact();
    const turn = await runTurn(
      this.client,
      this.tools,
      this.messages,
      this.toolDefs,
    );
    if (!turn.ok) return turn;
    // A failed auto-compact is non-fatal: proceed with the (uncut) conversation
    // and let the edge report that compaction did not happen.
    if (auto.ok) return turn;
    return { ok: true, value: turn.value, compactionWarning: auto.error };
  }

  /**
   * On-demand compaction (`/compact`). Summarizes the older portion of the
   * conversation and keeps the most recent turns verbatim. On any error the
   * conversation is left untouched and the error is returned.
   */
  private async compact(): Promise<Result<string>> {
    return this.doCompact();
  }

  /**
   * Auto-compaction guard, run before every normal turn. Returns a successful
   * no-op when nothing needed compacting (cold start, below threshold, or
   * nothing to summarize). When the last turn's server-reported usage is at or
   * above `COMPACTION_THRESHOLD` of the live window, performs the same
   * compaction as `/compact`. Best-effort: any failure is returned so the
   * caller can log it, but never blocks the turn.
   */
  private async maybeAutoCompact(): Promise<Result<string>> {
    const lastUsed = this.context.lastPromptTokensUsed();
    if (lastUsed === undefined) return okNoop();
    const max = await this.context.contextMax();
    if (!max.ok) return max;
    if (lastUsed < COMPACTION_THRESHOLD * max.value) return okNoop();
    return this.doCompact();
  }

  /**
   * Shared compaction body: split the conversation, summarize the older
   * portion, and replace the conversation with the summary plus the recent
   * turns. On any error the conversation is left untouched and the error is
   * returned.
   */
  private async doCompact(): Promise<Result<string>> {
    const conversation = this.messages.slice(1); // drop the system message
    const split = splitForCompaction(conversation, RECENT_TURNS_TO_KEEP);
    if (split.toSummarize.length === 0) {
      return okNoop();
    }
    const summary = await summarize(this.client, split.toSummarize);
    if (!summary.ok) {
      // Leave the conversation untouched; report the error.
      return { ok: false, error: summary.error };
    }
    const framed: Message = {
      role: "user",
      content: `Here is a summary of our conversation so far: ${summary.value}`,
    };
    const system = this.messages[0];
    this.messages.length = 0;
    if (system) this.messages.push(system);
    this.messages.push(framed);
    for (const m of split.recent) {
      this.messages.push(m);
    }
    return {
      ok: true,
      value: `compacted ${split.toSummarize.length} messages`,
    };
  }

  /**
   * Render `/context`. Reads the max live on every call (at most one `/slots`
   * request) and never makes a model call or pushes a message. Do not cache
   * `contextMax` across turns here: the live read is what keeps the reported
   * window accurate if the server's window changes.
   */
  private async reportContext(): Promise<Result<string>> {
    const max = await this.context.contextMax();
    if (!max.ok) return { ok: false, error: max.error };
    const used = this.context.lastPromptTokensUsed() ?? 0;
    return { ok: true, value: formatContext(used, max.value) };
  }

  /**
   * Handle `/model` and `/model <name>`.
   * When name is omitted: lists available models from the server.
   * When name is provided: validates the name and switches the active model.
   */
  private async handleModelCommand(line: string): Promise<Result<string>> {
    if (!this.modelController) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: "model switching not supported by the current client",
        },
      };
    }

    const arg = line.slice("/model".length).trim();
    if (arg === "") {
      const models = await this.modelController.listModels();
      if (!models.ok) return models;
      const current = this.modelController.getModel();
      return {
        ok: true,
        value: formatModelList(models.value, current),
      };
    }

    const models = await this.modelController.listModels();
    if (!models.ok) return models;
    if (!models.value.includes(arg)) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: `unknown model '${arg}'. Run '/model' to see available models.`,
        },
      };
    }

    this.modelController.setModel(arg);
    return { ok: true, value: `switched to model ${arg}` };
  }
}

/** A successful no-op compaction result: nothing needed to be compacted. */
function okNoop(): Result<string> {
  return { ok: true, value: "nothing to compact" };
}
