import { runTurn, splitForCompaction, summarize } from "../core/engine.ts";
import type {
  Client,
  Tool,
  ToolController,
  ToolRunner,
} from "../core/engine.ts";
import type {
  Message,
  Result,
  ViseError,
  PromptProgress,
} from "../core/errors.ts";
import { formatHelp, formatProfileList } from "../output/format.ts";
import {
  handleModelCommand,
  handleNotesCommand,
  handleToolCommand,
  reportContext,
} from "./commands.ts";

/**
 * The outcome of a handled line. A successful turn carries the model's reply
 * and, when auto-compaction failed before the turn, an optional
 * `compactionWarning` the edge surfaces on stderr. This keeps all I/O at the
 * edge (invariant #2): the session never writes to stdout or stderr itself.
 */
export type LineResult =
  | "exit"
  | {
      ok: true;
      value: string;
      streamed?: boolean;
      compactionWarning?: ViseError;
    }
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
 * Source of note listings for the `/note` command. A note is the project's
 * combined "memories" (short facts) and "skills" (how-to procedures) store,
 * exposed to the model on demand via tools and to the user via `/note`.
 * Only listing is supported here: the model does its own reads/writes through
 * the note tools. Provided by the edge (the session performs no I/O).
 */
export interface NoteSource {
  /** List all notes with their one-line summaries. */
  listNotes(): Promise<Result<string[]>>;
  /** Initialize a new note with a placeholder template body. */
  initNote(name: string): Promise<Result<string>>;
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
 * Post-turn hook: runs a configured shell command after every successful turn
 * and returns its combined output (stdout/stderr or error text). The output
 * is injected as a user message after the assistant's reply, so the model
 * sees it in the next turn. Provided by the edge (the session performs no I/O).
 */
export interface PostTurnHook {
  /** Run the post-turn hook command and return its combined output. */
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
 * Edge-provided options for constructing a Session. Groups the optional
 * edge services (model controller, profile source, hooks) and the required
 * context source + cwd into a single object, so adding a new service is
 * a new optional field, not a new positional parameter.
 */
export interface SessionOptions {
  cwd: string;
  context: ContextSource;
  modelController?: ModelController;
  toolController?: ToolController;
  profileSource?: ProfileSource;
  noteSource?: NoteSource;
  preTurnHooks: PreTurnHook[];
  postTurnHooks: PostTurnHook[];
  /**
   * Edge-provided callback invoked with each token of the user turn's reply as
   * it streams in. The session performs no I/O itself (invariant #2); this is
   * the edge's sink for streamed tokens. When absent, replies are not
   * streamed. Used only for normal user turns, not for compaction or other
   * internal model calls.
   */
  onToken?: (token: string) => void;
  /**
   * Edge-provided callback invoked with each token of the model's thinking
   * (reasoning_content) as it streams in, before the reply content. The
   * session performs no I/O itself (invariant #2); this is the edge's sink
   * for streamed thinking tokens, so the edge can show a live count without
   * printing the thinking text. Used for all model calls including tool
   * rounds.
   */
  onThinking?: (token: string) => void;
  /**
   * Edge-provided callback invoked with the prompt-processing progress
   * reported in every streaming chunk (llama.cpp `return_progress`). The
   * session performs no I/O itself (invariant #2); this is the edge's sink
   * for the live prompt count, so it can show how many prompt tokens are
   * being computed during the silent prefill. Used for all model calls
   * including tool rounds.
   */
  onPromptProgress?: (progress: PromptProgress) => void;
  /**
   * Initial context injected as the first user message after the system
   * message. Provided by the edge at construction time; typically contains
   * the working directory's initial file structure so the model has a
   * starting map of the project without calling tools.
   */
  initialMessage?: string;
}

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
  private readonly toolController?: ToolController;
  private readonly profileSource?: ProfileSource;
  private readonly noteSource?: NoteSource;
  private readonly preTurnHooks: PreTurnHook[];
  private readonly postTurnHooks: PostTurnHook[];
  private readonly cwd: string;
  private readonly onToken?: (token: string) => void;
  private readonly onThinking?: (token: string) => void;
  private readonly onPromptProgress?: (progress: PromptProgress) => void;
  private readonly initialMessage?: string;
  private activeProfile: string | undefined;

  constructor(
    client: Client,
    tools: ToolRunner,
    toolDefs: Tool[],
    options: SessionOptions,
  ) {
    this.client = client;
    this.tools = tools;
    this.toolDefs = toolDefs;
    this.context = options.context;
    this.modelController = options.modelController;
    this.toolController = options.toolController;
    this.profileSource = options.profileSource;
    this.noteSource = options.noteSource;
    this.preTurnHooks = options.preTurnHooks;
    this.postTurnHooks = options.postTurnHooks;
    this.cwd = options.cwd;
    this.onToken = options.onToken;
    this.onThinking = options.onThinking;
    this.onPromptProgress = options.onPromptProgress;
    this.initialMessage = options.initialMessage;
    this.systemMessage = {
      role: "system",
      content: `Working directory: ${options.cwd}`,
    };
    this.messages = [this.systemMessage];
    if (this.initialMessage !== undefined && this.initialMessage !== "") {
      this.messages.push({ role: "user", content: this.initialMessage });
    }
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
          hasTools: !!this.toolController,
          hasProfile: !!this.profileSource,
          hasNotes: !!this.noteSource,
          preTurnHookCount: this.preTurnHooks.length,
          postTurnHookCount: this.postTurnHooks.length,
        }),
      };
    if (trimmed === "/context") return reportContext(this.context);
    if (trimmed === "/compact") return this.doCompact();
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      return handleModelCommand(this.modelController, trimmed);
    }
    if (trimmed === "/tool" || trimmed.startsWith("/tool ")) {
      return handleToolCommand(
        this.toolController,
        trimmed,
        (name, enabled) => {
          // A tool's enabled state changed; tell the model so it stops calling
          // disabled tools and knows to invoke newly-enabled ones. The full
          // definition list is always sent regardless, so this is a state
          // note, not a change to the tools offered.
          this.messages.push({
            role: "user",
            content: enabled
              ? `Tool '${name}' is now enabled. You may call it.`
              : `Tool '${name}' is now disabled. Do not call it; if asked, say it is disabled.`,
          });
        },
      );
    }
    if (trimmed === "/profile" || trimmed.startsWith("/profile ")) {
      return this.handleProfileCommand(trimmed);
    }
    if (trimmed === "/note" || trimmed.startsWith("/note ")) {
      return handleNotesCommand(this.noteSource, trimmed);
    }
    await this.runHooks(this.preTurnHooks);
    this.messages.push({ role: "user", content: line });
    const auto = await this.maybeAutoCompact();
    const streamed = this.onToken !== undefined;
    const turn = await runTurn(
      this.client,
      this.tools,
      this.messages,
      this.toolDefs,
      this.onToken,
      this.onThinking,
      this.onPromptProgress,
    );
    if (!turn.ok) return turn;
    await this.runHooks(this.postTurnHooks);
    // A failed auto-compact is non-fatal: proceed with the (uncut) conversation
    // and let the edge report that compaction did not happen. The `streamed`
    // flag tells the edge the reply text (if any) was already written
    // token-by-token, so it only needs to emit the trailing newline rather
    // than re-print.
    if (auto.ok) {
      return { ok: true, value: turn.value, streamed };
    }
    return {
      ok: true,
      value: turn.value,
      streamed,
      compactionWarning: auto.error,
    };
  }

  /**
   * Run all hooks in the given list in parallel and push each non-blank
   * output as a user message, in config order. Shared by the pre-turn and
   * post-turn paths so the parallel execution, non-blank filter, and
   * injection logic live in one place.
   */
  private async runHooks(hooks: PreTurnHook[] | PostTurnHook[]): Promise<void> {
    if (hooks.length === 0) return;
    const outputs = await Promise.all(hooks.map((h) => h.run()));
    for (const output of outputs) {
      if (output.trim() !== "") {
        this.messages.push({ role: "user", content: output });
      }
    }
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
