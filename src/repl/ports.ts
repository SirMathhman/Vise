import type { Client } from "../core/engine.ts";
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
  /** List all notes with their one-line summaries. */
  listNotes(): Promise<Result<string[]>>;
  /** Initialize a new note with a placeholder template body. */
  initNote(name: string): Promise<Result<string>>;
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
 * A snapshot of a conversation at a point in time, persisted for later
 * resumption. The `messages` array includes the system message; `activeProfile`
 * is the profile name that was active when the snapshot was taken (undefined
 * when no profile was set).
 */
export interface SavedSession {
  messages: Message[];
  activeProfile: string | undefined;
  savedAt: string;
}

/**
 * Source of saved session snapshots. The session calls `save` after every
 * successful normal turn (auto-save) and calls `load`/`list` for the
 * `/resume` command. Provided by the edge (the session performs no I/O).
 */
export interface SessionSource {
  /**
   * Persist the conversation under the given name (the auto-save path).
   * Resolve a collision on the initial save; overwrite the resolved name on
   * subsequent saves. The final name is returned. Fails with a `malformed`
   * error when the name is invalid.
   */
  save(
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
    overwrite: boolean,
  ): Promise<Result<string>>;
  /**
   * Persist the current conversation under a user-chosen name (the manual
   * `/save <name>` path). When `name` is already taken, a numeric suffix is
   * appended and the final name is returned as the result value. Fails with
   * a `malformed` error when the name is invalid.
   */
  saveNamed(
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
  ): Promise<Result<string>>;
  /** Load a saved session by name. Fails with a `malformed` error when not found. */
  load(name: string): Promise<Result<SavedSession>>;
  /** List all saved session names (without file extension). */
  list(): Promise<Result<string[]>>;
  /**
   * Delete a saved session by name. Fails with a `malformed` error when the
   * session does not exist.
   */
  delete(name: string): Promise<Result<void>>;
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
  /**
   * Set the auto-save session name. Used by `/resume` so a resumed
   * conversation keeps writing to its own file rather than colliding into a
   * freshly derived name.
   */
  setSessionName(name: string): void;
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
}
