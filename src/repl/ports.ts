import type { AuditSink } from "../core/audit.ts";
import type { Picture } from "../core/errors.ts";
import type { Client } from "../core/engine.ts";
import type { GoalLog, GoalTraceEntry } from "../core/goal-trace.ts";
import type { TodoItem, TodoStore } from "../core/todos.ts";
import type { Workflow, WorkflowScope } from "../core/workflow.ts";
import type { Message, Result } from "../core/errors.ts";

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
 * Pre-turn hook: runs a configured shell command before every turn and returns
 * its combined output (stdout/stderr or error text). The output is injected
 * as context into the user's message so the model sees it each turn. Provided
 * by the edge (the session performs no I/O).
 */
export interface PreTurnHook {
  /** The command line the hook runs, shown by `/hooks` and `self`. */
  readonly command: string;
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
  /** The command line the hook runs, shown by `/hooks` and `self`. */
  readonly command: string;
  /** Run the post-turn hook command and return its combined output. */
  run(): Promise<string>;
}

/**
 * Store for the hook command lists (`.viserc.json`). Provided by the edge: it
 * builds runnable hooks and persists the lists; the session only edits them.
 */
export interface HookSource {
  /** Build a runnable hook for a command line. */
  create(command: string): PreTurnHook & PostTurnHook;
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
