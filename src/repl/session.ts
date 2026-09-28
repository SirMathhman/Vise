import { runTurn, splitForCompaction, summarize } from "../core/engine.ts";
import type { Client, Tool, ToolRunner } from "../core/engine.ts";
import type { Message, Result, ViseError } from "../core/errors.ts";
import {
  formatContext,
  formatHelp,
  formatModelList,
  formatProfileList,
} from "../output/format.ts";

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
 * Source of profile text. A profile is free-form instruction text appended
 * to the conversation as a user message to shape the assistant's persona.
 * The system message is never modified by profile switching (invariant:
 * this preserves prompt-prefix caching). Provided by the edge (the session
 * performs no I/O).
 */
export interface ProfileSource {
  /** Names of the available profiles (without file extension). */
  listProfiles(): Promise<Result<string[]>>;
  /** Load the full text of the named profile. Empty string when unset. */
  loadProfile(name: string): Promise<Result<string>>;
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
 * Pre-turn hook: runs a configured shell command before every turn and returns
 * its combined output (stdout/stderr or error text). The output is injected
 * as context into the user's message so the model sees it each turn. Provided
 * by the edge (the session performs no I/O).
 */
export interface PreTurnHook {
  /** Run the pre-turn hook command and return its combined output. */
  run(): Promise<string>;
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
  private readonly systemMessage: Message;
  private readonly client: Client;
  private readonly tools: ToolRunner;
  private readonly toolDefs: Tool[];
  private readonly context: ContextSource;
  private readonly modelController?: ModelController;
  private readonly profileSource?: ProfileSource;
  private readonly preTurnHook?: PreTurnHook;
  private readonly cwd: string;
  private activeProfile: string | undefined;

  constructor(
    client: Client,
    tools: ToolRunner,
    toolDefs: Tool[],
    context: ContextSource,
    cwd: string,
    modelController?: ModelController,
    profileSource?: ProfileSource,
    preTurnHook?: PreTurnHook,
  ) {
    this.client = client;
    this.tools = tools;
    this.toolDefs = toolDefs;
    this.context = context;
    this.modelController = modelController;
    this.profileSource = profileSource;
    this.preTurnHook = preTurnHook;
    this.cwd = cwd;
    this.systemMessage = {
      role: "system",
      content: `Working directory: ${cwd}`,
    };
    this.messages = [this.systemMessage];
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
    if (trimmed === "/help")
      return {
        ok: true,
        value: formatHelp({
          hasModel: !!this.modelController,
          hasProfile: !!this.profileSource,
          hasPreTurnHook: !!this.preTurnHook,
        }),
      };
    if (trimmed === "/context") return this.reportContext();
    if (trimmed === "/compact") return this.doCompact();
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      return this.handleModelCommand(trimmed);
    }
    if (trimmed === "/profile" || trimmed.startsWith("/profile ")) {
      return this.handleProfileCommand(trimmed);
    }
    if (this.preTurnHook) {
      const hookOutput = await this.preTurnHook.run();
      if (hookOutput.trim() !== "") {
        this.messages.push({ role: "user", content: hookOutput });
      }
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
    this.messages.length = 0;
    this.messages.push(this.systemMessage);
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

  /**
   * Handle `/profile` and `/profile <name>`.
   * When name is omitted: lists available profiles from the source.
   * When name is provided: loads the profile text and appends it to the
   * conversation as a user message. The system message is never modified
   * (invariant: profile instructions are appended, not injected into the
   * system prompt, to preserve prefix caching).
   * An empty profile file appends a clearing instruction instead.
   */
  private async handleProfileCommand(line: string): Promise<Result<string>> {
    if (!this.profileSource) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: "profiles not supported by the current client",
        },
      };
    }

    const arg = line.slice("/profile".length).trim();
    if (arg === "") {
      const profiles = await this.profileSource.listProfiles();
      if (!profiles.ok) return profiles;
      return {
        ok: true,
        value: formatProfileList(profiles.value, this.activeProfile),
      };
    }

    const loaded = await this.profileSource.loadProfile(arg);
    if (!loaded.ok) return loaded;
    const body = loaded.value.trim();
    this.activeProfile = body === "" ? undefined : arg;
    if (body !== "") {
      this.messages.push({ role: "user", content: body });
    } else {
      this.messages.push({
        role: "user",
        content:
          "Profile cleared. Please disregard any previous profile instructions.",
      });
    }
    return {
      ok: true,
      value: body === "" ? "profile cleared" : `profile set to ${arg}`,
    };
  }
}

/** A successful no-op compaction result: nothing needed to be compacted. */
function okNoop(): Result<string> {
  return { ok: true, value: "nothing to compact" };
}
