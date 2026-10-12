import type { AuditSink } from "../core/audit.ts";
import type { Picture } from "../core/errors.ts";
import type { Client, SummaryPrefix } from "../core/engine.ts";
import type { GoalLog, GoalTraceEntry } from "../core/goal-trace.ts";
import type { TodoItem, TodoStore } from "../core/todos.ts";
import type { Workflow, WorkflowScope } from "../core/workflow.ts";
import type { Message, Result, ViseError } from "../core/errors.ts";

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
  /**
   * Initialize a new profile with a placeholder template body. Fails with a
   * `malformed` error when the name is invalid or the profile already exists.
   */
  initProfile(name: string): Promise<Result<string>>;
  /** The profile's tool whitelist, or undefined when it has none. */
  profileTools?(name: string): Promise<Result<string[] | undefined>>;
  /** Set (or clear with undefined) the profile's tool whitelist. */
  setProfileTools?(
    name: string,
    tools: string[] | undefined,
  ): Promise<Result<string>>;
  /** The hooks each profile owns, as `pre:<command>` / `post:<command>` entries (profiles with none are omitted). */
  profileHooks?(): Promise<Result<Record<string, string[]>>>;
  /** Set (or clear with an empty list) the hooks a profile owns. */
  setProfileHooks?(name: string, hooks: string[]): Promise<Result<string>>;
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
  /** True for a hosted provider (OpenRouter): its model list is huge and incomplete, so any id is accepted and the list is capped. */
  hostedModels?(): boolean;
  /** False when the provider cannot constrain calls with a grammar, so burst mode (which needs one) is refused. */
  supportsBurst?(): boolean;
}

/**
 * Controller for the active `reasoning_effort` level. Like `ModelController`,
 * this is edge-owned mutable state surfaced to the core's `Session` through a
 * narrow interface; the session performs no I/O and just delegates to it.
 */
export interface ReasoningController {
  /** The active level, or `undefined` when none is set (template default). */
  getReasoningEffort(): string | undefined;
  /** Set the active level. Pass `undefined` or `"default"` to clear. */
  setReasoningEffort(effort: string | undefined): void;
}

/**
 * Source of note listings for the `/note` command. A note is the project's
 * combined "memories" (short facts) and "skills" (how-to procedures) store,
 * exposed to the model on demand via tools and to the user via `/note`.
 * Only listing is supported here: the model does its own reads/writes through
 * the note tools. Provided by the edge (the session performs no I/O).
 */
export interface NoteSource {
  /** List all notes grouped by category, with their one-line summaries. */
  listNotes(): Promise<Result<string[]>>;
  /** Initialize a new note (in `category`, default when omitted; in the project unless `global`) with a placeholder template body. */
  initNote(
    name: string,
    category?: string,
    scope?: "project" | "global",
  ): Promise<Result<string>>;
  /** Every note with exactly this name, in any scope and category, with its body. */
  findNotes(
    name: string,
  ): Promise<Result<{ scope: string; category: string; body: string }[]>>;
}

/** Edge-owned loading of an image file the user attaches with `/image <path>`. */
export interface ImageSource {
  load(path: string): Promise<Result<Picture>>;
}

/** Edge-owned workflow listing, loading, and creation. */
export interface WorkflowSource {
  listWorkflows(): Promise<
    Result<{ name: string; scope: WorkflowScope; active: boolean }[]>
  >;
  loadWorkflow(name: string): Promise<Result<Workflow>>;
  initWorkflow(name: string, scope: WorkflowScope): Promise<Result<string>>;
}

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
 * A configured shell command run around a turn, returning its combined output
 * (stdout/stderr or error text). Provided by the edge (the session performs no
 * I/O). Which side it is on decides what happens to the output: a pre-turn
 * hook's is injected as context into the user's message; a post-turn hook's is
 * a user message after the reply, which the model sees in the next turn.
 */
export interface TurnHook {
  /** The command line the hook runs, shown by `/hooks` and `self`. */
  readonly command: string;
  /** Run the command and return its combined output. */
  run(): Promise<string>;
}

export type PreTurnHook = TurnHook;
export type PostTurnHook = TurnHook;

/**
 * Store for the hook command lists (`.viserc.json`). Provided by the edge: it
 * builds runnable hooks and persists the lists; the session only edits them.
 */
export interface HookSource {
  /** Build a runnable hook for a command line. */
  create(command: string): TurnHook;
  /** Persist the full pre/post command lists. */
  save(hooks: { pre: string[]; post: string[] }): Result<void>;
  /** Tell views of the hooks that something about them changed (e.g. a profile's own hooks). */
  notify?(): void;
}

/**
 * A saved conversation snapshot. `id` is the generated file id (a uuid) and
 * `name` the human-readable label; the label can change, the id never does.
 * `activeProfile` is the profile active at save time (undefined when none).
 */
export interface SavedSession {
  id: string;
  name: string;
  messages: Message[];
  activeProfile: string | undefined;
  /** The agent's todo list at save time. */
  todos?: TodoItem[];
  /** The goal trace saved with the conversation (for debugging; never part of the conversation itself). */
  goalTrace?: GoalTraceEntry[];
  savedAt: string;
}

/** A saved session that mentions the text searched for. */
export interface SearchHit {
  id: string;
  name: string;
  snippet: string;
}

/** One row of the saved-session listing. */
export interface SessionEntry {
  id: string;
  name: string;
  /** When it was last saved (ISO 8601), when the store knows. */
  updated?: string;
}

/**
 * Source of saved session snapshots, keyed by generated id. The session calls
 * `save` after every successful normal turn (auto-save) and for `/save`, and
 * `load`/`list`/`delete` for `/resume` and `/delete`. A `ref` is a full id or
 * the unique leading characters of one. Provided by the edge (the session
 * performs no I/O).
 */
export interface SessionSource {
  /**
   * Persist the conversation. With no `id` a new session is created and its
   * new id returned; with an `id` that session is overwritten (and renamed to
   * `name`). Fails with a `malformed` error when the name is blank.
   */
  save(
    id: string | undefined,
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
    todos?: TodoItem[],
    goalTrace?: GoalTraceEntry[],
  ): Promise<Result<string>>;
  /** Load a saved session by id or unique id prefix. */
  load(ref: string): Promise<Result<SavedSession>>;
  /** List all saved sessions (id and display name). */
  list(): Promise<Result<SessionEntry[]>>;
  /** Delete a saved session by id or prefix; returns the full id. */
  delete(ref: string): Promise<Result<string>>;
  /** The saved sessions whose messages mention `text`, with a snippet of where. */
  search?(text: string): Promise<Result<SearchHit[]>>;
}

/**
 * The subset of Session state the profile command needs, exposed to
 * `session-commands.ts` so the handler can be a plain module-level function
 * (matching the `commands.ts` pattern) rather than a private method on the
 * class. The Session implements this with closures over its own fields.
 */
export interface ProfileCommands {
  profileSource(): ProfileSource | undefined;
  activeProfile(): string | undefined;
  setActiveProfile(name: string | undefined): void;
  pushMessage(message: Message): void;
  /** Names of every known tool (for validating a whitelist). */
  toolNames(): string[];
  /**
   * Enable only `tools` (remembering the prior states), or, with undefined,
   * restore the states remembered before a whitelist was applied.
   */
  applyProfileTools(tools: string[] | undefined): void;
}

/**
 * The subset of Session state the resume/save commands need, exposed to
 * `session-commands.ts` so the handlers can be plain module-level functions
 * (matching the `commands.ts` pattern) rather than private methods on the
 * class. The Session implements this with closures over its own fields.
 */
export interface SessionCommands {
  sessionSource(): SessionSource | undefined;
  activeProfile(): string | undefined;
  setActiveProfile(name: string | undefined): void;
  pushMessage(message: Message): void;
  /**
   * Return the live messages array as a shallow copy (system message first).
   * Used by `/save` to snapshot the current conversation.
   */
  messages(): Message[];
  /**
   * Replace the conversation body with the given messages, keeping the live
   * system message at index 0 (invariant #6). Used by `/resume`.
   */
  resetMessages(messages: Message[]): void;
  /** The id and display name of the conversation's session, once it has one. */
  currentSession(): { id: string | undefined; name: string | undefined };
  /** Point the conversation at a session (undefined: it has none yet). */
  setSession(id: string | undefined, name: string | undefined): void;
  /** Apply a profile's tool whitelist (undefined: lift it); `/resume` re-applies the restored profile's. */
  applyProfileTools?(name: string | undefined): Promise<void>;
  /** The agent's todo list (saved with the session). */
  todos: TodoStore | undefined;
  /** The goal trace (saved with the session, restored on resume so it keeps growing). */
  goalLog: GoalLog | undefined;
}

/**
 * The subset of Session state the compaction handler needs, exposed to
 * `compaction.ts` so the handler can be a plain module-level function
 * (matching the `commands.ts` pattern) rather than a private method on the
 * class. The Session implements this with closures over its own fields.
 */
export interface CompactionSource {
  /** The client used for the summarizing model call. */
  client: Client;
  /** Return the live messages array as a shallow copy (system message first). */
  messages(): Message[];
  /**
   * Replace the conversation body with the given messages, keeping the live
   * system message at index 0 (invariant #6). Used after summarizing.
   */
  resetMessages(messages: Message[]): void;
  /** Told what each compaction did (the audit log). */
  audit?: AuditSink;
  /**
   * The conversation's system message and tool list: the summarizing call is
   * encoded with them so it shares the conversation's cached prompt prefix.
   */
  prefix?(): SummaryPrefix | undefined;
}

/** The MCP servers behind `/mcp` (provided by the edge). */
export interface McpStatusSource {
  status(): {
    name: string;
    status: { state: string; reason?: string };
    tools: number;
    stderr: string;
  }[];
  /** Config entries that were skipped, each with the reason. */
  problems: string[];
  /** Reconnect one server; the result text says how it went (`error:` when it failed). */
  restart(name: string): Promise<string>;
}

/** One place in a file that is close in meaning to a query. */
export interface SemanticHit {
  /** Relative to the folder, with `/` separators. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Cosine similarity with the query (higher is closer). */
  score: number;
  /** The start of the passage, for display. */
  snippet: string;
}

/** What a semantic index is doing, for the user and for the model's tool. */
export interface SemanticStatus {
  /** `unavailable`: the embedding model cannot be used (see `reason`); `empty`: nothing indexed yet. */
  state: "unavailable" | "empty" | "indexing" | "ready";
  files: number;
  chunks: number;
  /** The embedding model the index is built with. */
  model: string;
  /** While `indexing`: files done of files to do. */
  done?: number;
  total?: number;
  /** Why it is unavailable, or what to do about an index built with another model. */
  reason?: string;
}

/** What a run of `update` did. */
export interface SemanticUpdateStats {
  indexed: number;
  /** Up to date, or unreadable/binary. */
  skipped: number;
  /** In the index but gone (or no longer indexable) and so forgotten. */
  removed: number;
  failed: number;
}

/**
 * A folder's files searchable by meaning. One per project, shared by every
 * page and the terminal; the user's `/search semantic`, the web file
 * explorer's search box and the model's `semantic_search` tool all go through
 * it. Provided by the edge (it embeds over the network and stores to SQLite).
 */
export interface SemanticIndexPort {
  /** The `limit` closest passages to `query`, best first, one per place (overlapping windows are merged). */
  search(query: string, limit: number): Promise<Result<SemanticHit[]>>;
  status(): SemanticStatus;
  /**
   * Index new and changed files and forget vanished ones; `rebuild` clears
   * first. One run at a time: a call during a run joins it.
   */
  update(options?: { rebuild?: boolean }): Promise<Result<SemanticUpdateStats>>;
  /** Be told when the status changes (progress, finished, failed); returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}
