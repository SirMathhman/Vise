import type {
  AssistantMessage,
  Picture,
  Message,
  CallPurpose,
  PromptProgress,
  Result,
  ToolCall,
} from "./errors.ts";
import { z } from "zod";
import { isSummaryFrame } from "./compaction/pins.ts";
import { parse } from "./schemas/parse.ts";
import { toolCallArgsSchema } from "./schemas/tool-args.ts";

/**
 * Definition of a single tool function, as presented to the model. The core
 * owns this type; the edge provides the `Tool[]` definitions and the
 * `ToolRunner` implementation.
 */
export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  /** How a call of this tool is shown to the user: a readable name and an icon (the model and `/tool` use the real name). */
  display?: { label: string; icon: string };
  /**
   * Deferred tools are listed in the prompt by name and summary only; the
   * model fetches the full signature with `search_tools`. They stay callable.
   */
  deferred?: boolean;
  /** Group the tool belongs to (files, shell, browser, ...); shown in the prompt index and searchable. */
  category?: string;
  /** Needs a file system or shell: absent from a session with no working directory. */
  requiresFileSystem?: boolean;
  /** Produces or needs pictures: usable only while the active model can see images. */
  requiresVision?: boolean;
  /** Always listed in full in the prompt; every other tool is deferred to `search_tools`. */
  core?: boolean;
  /** Starts disabled (it runs unsandboxed code); the user opts in with `/tool <name> enable`. */
  defaultDisabled?: boolean;
  /** Bounds its own output, so the runner does not spill a long result to a temp file. */
  boundsOwnOutput?: boolean;
}

/**
 * The core depends only on this type, not on a concrete transport, so it can
 * be tested with a stub. The edge provides the implementation (currently
 * `LlmClient` in `client/llm.ts`).
 */
export interface Client {
  chat(
    messages: Message[],
    tools?: Tool[],
    onToken?: (token: string) => void,
    onThinking?: (token: string) => void,
    onPromptProgress?: (progress: PromptProgress) => void,
    responseSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    isToolEnabled?: (name: string) => boolean,
    act?: boolean,
  ): Promise<Result<AssistantMessage>>;
  /**
   * The same client, its calls labelled with what they are for. Optional: a
   * client that does not label (a test stub) is used as it is.
   */
  as?(purpose: CallPurpose): Client;
}

/**
 * Executes a tool invocation with the given name and arguments, returning a
 * string result (or an error string). The edge provides the implementation;
 * the core depends only on this interface so it can be tested with a stub.
 */
export interface ToolRunner {
  /** `signal` aborts a long-running tool (a wait) when the user interrupts the turn. */
  run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  /** The pictures the last `run` produced (handed over once): they travel with its result. */
  takeImages?(): Picture[];
}

/** Told that a tool call is starting: its name, how deep in subagents it is, and its parsed arguments (for display). */
export type ToolCallListener = (
  name: string,
  depth?: number,
  args?: Record<string, unknown>,
) => void;

/** Told that a tool call finished: its name, how deep in subagents it is, and the result the model got (for display). */
export type ToolResultListener = (name: string, depth: number, result: string) => void;

export interface TurnCallbacks {
  onToken?: (token: string) => void;
  onThinking?: (token: string) => void;
  onToolCall?: ToolCallListener;
  onToolResult?: ToolResultListener;
  /** A tool produced a picture (for the user to see; the model already gets it with the result). */
  onImage?: (image: Picture) => void;
  /**
   * Plain-text stream of a subagent's reply. A frontend that can style it
   * itself (the web UI) supplies this; when absent the subagent handler
   * falls back to a dimmed, indented copy sent through `onToken`.
   */
  onSubagentToken?: (token: string, depth?: number) => void;
  /** A subagent's turn is over: its whole private conversation (system message first), for the record. */
  onSubagentDone?: (messages: Message[]) => void;
  /** Asked when a turn has run `MAX_TOOL_ROUNDS` rounds (and by other long-running loops); `question` says what is being asked. */
  onMaxRounds?: (question: string) => Promise<boolean>;
  /**
   * Called before each model round after the first, with the number of rounds
   * this turn has run. It is where long turns get their upkeep (compacting a
   * filling conversation, saving, checking that the work is going somewhere).
   * Returning a reason ends the turn there; undefined carries on.
   */
  onRound?: (
    round: number,
    messages: Message[],
    /** The tool definitions of the turn, so upkeep calls can be encoded like its own rounds. */
    toolDefs: Tool[],
  ) => Promise<string | undefined>;
  /**
   * Whether a tool is currently enabled. The client restricts generation so
   * disabled tools cannot be called, without altering the tool definitions
   * (and therefore the prompt). When absent, every tool is allowed.
   */
  isToolEnabled?: (name: string) => boolean;
  /**
   * Burst mode: think once to plan, then run tool calls without thinking in
   * between. The loop returns to thinking when a tool errors, when the model
   * signals the plan is done, or when its tool choice is uncertain.
   */
  burst?: boolean;
  /** Notified when burst mode enters (true) or leaves (false) an act round. */
  onBurst?: (active: boolean) => void;
  /**
   * Aborts the turn when the user interrupts (e.g. Ctrl+C). The edge sets the
   * signal on interrupt; the core threads it to the in-flight model call and
   * stops the tool loop between rounds. When absent, turns run to completion.
   */
  abort?: AbortSignal;
}

/**
 * Controls which tools are enabled. The full set of tool definitions is
 * always sent to the model regardless of enabled state — disabling a tool
 * does not change the definitions offered to the model; it only makes the
 * `ToolRunner` reject invocations of that tool. The edge provides the
 * implementation (currently `ToolSet` in `tools.ts`); the core depends only
 * on this interface so it can be tested with a stub.
 */
export interface ToolController {
  /** All known tools with their enabled state, in definition order. */
  list(): {
    name: string;
    enabled: boolean;
    category?: string;
  }[];
  /** Enable or disable a tool by name. */
  set(name: string, enabled: boolean): void;
  /** Whether a tool is currently enabled. */
  isEnabled(name: string): boolean;
  /**
   * The tools as the user set them, ignoring a profile's tool restriction (what
   * a subagent starts from: it never inherits the main agent's restriction).
   * Optional: a controller without restrictions has only `isEnabled`.
   */
  baselineEnabled?(name: string): boolean;
  /** Remember the states from before a profile restricted the tools (`undefined`: no restriction now). */
  setBaseline?(states: Map<string, boolean> | undefined): void;
}

/** A turn can legitimately make hundreds of tool calls; past this many rounds the user is asked whether to go on. */
const MAX_TOOL_ROUNDS = 500;

/**
 * Burst mode: the plan round's reasoning is kept in history (capped to this
 * many trailing characters) so act rounds, which cannot think, can follow it.
 */
const PLAN_MAX_CHARS = 4000;

/** Burst mode: below this tool-choice probability, think again. */
export const BURST_MIN_CONFIDENCE = 0.5;

/**
 * The text appended to the conversation to request a summary of it. Kept
 * as a constant so the compaction prompt is stable and greppable.
 */
export const SUMMARIZE_PROMPT =
  "Summarize this conversation so that work can continue from the summary alone. Cover: " +
  "the task and its current state; what has been done and what is still pending; " +
  "any standing instructions, restrictions or preferences the user gave, quoted in their words; " +
  "decisions made and questions still open; and the identifiers needed to continue " +
  "(tab numbers, file paths, ids, URLs, names).";

/**
 * A partition of the conversation for compaction. `toSummarize` is the older
 * portion that will be replaced by a summary; `recent` is the tail of
 * complete turns that is preserved verbatim.
 */
export interface CompactionSplit {
  toSummarize: Message[];
  recent: Message[];
}

/**
 * Split the conversation into the portion to summarize and the most recent
 * `recentTurns` complete turns to keep. A "turn" starts at a user message and
 * runs through the assistant/tool messages that follow it up to the next user
 * message, so the kept tail is always a self-contained, API-valid sequence
 * (no dangling tool_call/tool references). The leading system message is
 * always preserved by the caller and is not part of either half here; pass in
 * the conversation with the system message already removed.
 *
 * Pure: no I/O, depends only on the `Message` type. If there are no user
 * turns at all, everything goes to `toSummarize` and `recent` is empty.
 */
export function splitForCompaction(messages: Message[], recentTurns: number): CompactionSplit {
  // Find the indexes of every user message; these are turn boundaries.
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // A summary frame is a user message but not a turn: it is what earlier turns became.
    if (m && m.role === "user" && !isSummaryFrame(m)) boundaries.push(i);
  }
  if (boundaries.length === 0) {
    return { toSummarize: messages.slice(), recent: [] };
  }
  const keepFromIndex =
    boundaries.length <= recentTurns ? boundaries[0] : boundaries[boundaries.length - recentTurns];
  return {
    toSummarize: messages.slice(0, keepFromIndex),
    recent: messages.slice(keepFromIndex),
  };
}

/** What a summarizing call shares with the conversation it summarizes: its system message and tool list. */
export interface SummaryPrefix {
  system: Message;
  tools: Tool[];
}

/**
 * Produce a summary of the conversation's older portion. Sends the older
 * messages plus the `SUMMARIZE_PROMPT` to the model and returns the model's
 * summary text. Pure: no I/O beyond the `Client` and no `node:` imports.
 */
export async function summarize(
  client: Client,
  toSummarize: Message[],
  prefix?: SummaryPrefix,
): Promise<Result<string>> {
  const messages: Message[] = [
    ...(prefix ? [prefix.system] : []),
    ...toSummarize,
    { role: "user", content: SUMMARIZE_PROMPT },
  ];
  const labelled = client.as?.("compaction") ?? client;
  // With the conversation's own system message and tool list the request is
  // encoded as its turns are, so the server reuses their cached prefix instead
  // of re-reading it; no tool may be called, the answer is the summary.
  const result = prefix
    ? await labelled.chat(
        messages,
        prefix.tools,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
      )
    : await labelled.chat(messages);
  if (!result.ok) return result;
  return { ok: true, value: result.value.content };
}

/**
 * The upkeep step before a model round (see `TurnCallbacks.onRound`): returns
 * the result that ends the turn (interrupted, or stopped for a reason), or
 * undefined to carry on.
 */
async function betweenRounds(
  callbacks: TurnCallbacks,
  messages: Message[],
  rounds: number,
  toolDefs: Tool[],
): Promise<Result<string> | undefined> {
  if (rounds === 0 || !callbacks.onRound) return undefined;
  const stop = await callbacks.onRound(rounds, messages, toolDefs);
  if (callbacks.abort?.aborted) {
    return { ok: false, error: { kind: "interrupted" } };
  }
  if (stop === undefined) return undefined;
  // Kept in the conversation so the model (and the next turn) knows why it stopped.
  messages.push({ role: "assistant", content: stop });
  return { ok: true, value: stop };
}

/** What a picture counts for in `approxTokens`, in characters (about 4000 tokens; the server is set to 1k-16k per image). */
const IMAGE_CHARS = 14_000;

/** A rough token count for messages (about 3.5 characters a token); only ever used to size budgets. */
export function approxTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + (m.images?.length ?? 0) * IMAGE_CHARS;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3.5);
}

/**
 * Split inside one long turn, for when the conversation is too big but has too
 * few user messages to split by turns: the turn's opening user message and its
 * last `keepRounds` rounds (an assistant message with its tool results) are
 * kept verbatim (fewer when those alone would exceed `maxTailTokens`), and
 * everything before them, earlier turns and earlier rounds alike, is to be
 * summarized. Nothing to summarize when the turn has no more than `keepRounds`
 * rounds and they fit the budget. Pure.
 */
export function splitWithinTurn(
  messages: Message[],
  keepRounds: number,
  maxTailTokens = Number.POSITIVE_INFINITY,
): CompactionSplit {
  let start = -1;
  for (let i = messages.length - 1; i >= 0 && start < 0; i--) {
    if (messages[i]?.role === "user") start = i;
  }
  const opening = messages[start];
  const rounds: number[] = [];
  for (let i = start + 1; i < messages.length; i++) {
    if (messages[i]?.role === "assistant") rounds.push(i);
  }
  // The kept rounds: the last `keepRounds`, fewer when they alone are too big for `maxTailTokens`.
  let from = Math.max(0, rounds.length - keepRounds);
  while (from < rounds.length - 1 && approxTokens(messages.slice(rounds[from])) > maxTailTokens) {
    from++;
  }
  const tail = rounds[from];
  if (!opening || tail === undefined || from === 0) {
    return { toSummarize: [], recent: messages.slice() };
  }
  return {
    toSummarize: [...messages.slice(0, start), ...messages.slice(start + 1, tail)],
    recent: [opening, ...messages.slice(tail)],
  };
}

/**
 * Pure core pipeline: takes the accumulated conversation and a user line,
 * runs the model, dispatches any tool calls through `tools`, and returns the
 * assistant's final content. Mutates `messages` (appending assistant and
 * tool messages). No `node:` imports, no I/O — depends only on `Client` and
 * `ToolRunner`, so it is testable with stubs.
 *
 * `onMaxRounds` is called when the loop reaches `MAX_TOOL_ROUNDS` rounds. If
 * it returns `true` the counter resets and the loop continues; if `false` the
 * turn ends with an error. When omitted (subagents), the turn ends silently.
 */
/** The conversation message for a tool's result, carrying any pictures the tool produced. */
function toolResult(
  name: string,
  output: string,
  id: string,
  tools: ToolRunner,
  callbacks: TurnCallbacks,
): Message {
  callbacks.onToolResult?.(name, 0, output);
  const images = tools.takeImages?.() ?? [];
  for (const image of images) if (!image.quiet) callbacks.onImage?.(image);
  return {
    role: "tool",
    content: output,
    tool_call_id: id,
    ...(images.length > 0 ? { images } : {}),
  };
}

/** Tell the display a tool call is starting. */
function announceTool(callbacks: TurnCallbacks, tc: ToolCall): void {
  callbacks.onToolCall?.(tc.function.name, 0, parseArgs(tc.function.arguments));
}

/** A tool call's arguments as an object for display; undefined when they are not valid JSON. */
function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const checked = parse(z.record(z.string(), z.unknown()), parsed);
    return checked.ok ? checked.value : undefined;
  } catch {
    return undefined;
  }
}

/** One tool call of a reply: its output, or an `error:` result saying why it did not run (bad arguments, a handler that threw). */
async function runToolCall(
  tools: ToolRunner,
  tc: ToolCall,
  callbacks: TurnCallbacks,
): Promise<string> {
  const name = tc.function.name;
  const args = parseArgs(tc.function.arguments);
  if (args === undefined) {
    return `error: the arguments of ${name} were not a valid JSON object`;
  }
  const validated = parse(toolCallArgsSchema, { name, arguments: args });
  if (!validated.ok) {
    return `error: the arguments of ${name} were not a valid JSON object`;
  }
  try {
    return await tools.run(name, args, callbacks.abort);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `error: failed to execute ${name}: ${why}`;
  }
}

export async function runTurn(
  client: Client,
  tools: ToolRunner,
  messages: Message[],
  toolDefs: Tool[],
  callbacks: TurnCallbacks = {},
): Promise<Result<string>> {
  let rounds = 0;
  // True while a burst-mode plan is being executed without thinking.
  let act = false;
  let announced = false;
  const setBurst = (on: boolean): void => {
    if (on !== announced) callbacks.onBurst?.((announced = on));
  };
  while (true) {
    if (rounds >= MAX_TOOL_ROUNDS) {
      if (callbacks.onMaxRounds) {
        const keepGoing = await callbacks.onMaxRounds(
          `This turn has run ${rounds} rounds of tool calls. Keep going?`,
        );
        if (keepGoing) {
          rounds = 0;
          continue;
        }
      }
      return { ok: false, error: { kind: "malformed", body: "exceeded maximum tool rounds" } };
    }
    if (callbacks.abort?.aborted) {
      return { ok: false, error: { kind: "interrupted" } };
    }
    const between = await betweenRounds(callbacks, messages, rounds, toolDefs);
    if (between) return between;
    rounds += 1;
    const result = await client.chat(
      messages,
      toolDefs,
      callbacks.onToken,
      callbacks.onThinking,
      undefined,
      undefined,
      callbacks.abort,
      callbacks.isToolEnabled,
      act,
    );
    if (callbacks.abort?.aborted) {
      return { ok: false, error: { kind: "interrupted" } };
    }
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const reply = result.value;
    if (
      act &&
      (reply.done || !reply.tool_calls?.length || (reply.confidence ?? 1) < BURST_MIN_CONFIDENCE)
    ) {
      // Plan complete or choice uncertain: discard the reply and think.
      act = false;
      setBurst(false);
      continue;
    }
    if (act) setBurst(true);
    if (reply.tool_calls && reply.tool_calls.length > 0) {
      const plan = callbacks.burst && !act ? reply.reasoning?.trim() : "";
      messages.push({
        role: "assistant",
        content: plan
          ? `<plan>
${plan.slice(-PLAN_MAX_CHARS)}
</plan>
${reply.content}`
          : reply.content,
        tool_calls: reply.tool_calls,
      });
      let failed = false;
      for (const tc of reply.tool_calls) {
        announceTool(callbacks, tc);
        const output = await runToolCall(tools, tc, callbacks);
        failed ||= output.startsWith("error:");
        messages.push(toolResult(tc.function.name, output, tc.id, tools, callbacks));
      }
      act = !!callbacks.burst && !failed;
      if (!act) setBurst(false);
    } else {
      messages.push({ role: "assistant", content: reply.content });
      return { ok: true, value: reply.content };
    }
  }
}

/**
 * Run a subagent: a fresh conversation, isolated from the parent's, carrying
 * its own system message and profile. The subagent runs the same tool loop as
 * the parent (it receives the same `ToolRunner` and `Tool[]`, so it may in
 * turn call `run_subagent` and spawn its own subagents). Returns the
 * subagent's final assistant text.
 *
 * Pure: no `node:` imports, no I/O beyond the `Client` and `ToolRunner`. The
 * `profileText` is the subagent's defining instructions; it is appended as a
 * user message (never into the system message), the same convention the
 * session uses for `/profile <name>`.
 */
export async function runSubagent(
  client: Client,
  tools: ToolRunner,
  toolDefs: Tool[],
  systemMessage: Message,
  profileText: string,
  task: string,
  callbacks: TurnCallbacks = {},
): Promise<Result<string>> {
  const messages: Message[] = [systemMessage];
  if (profileText.trim() !== "") {
    messages.push({ role: "user", content: profileText });
  }
  messages.push({ role: "user", content: task });
  try {
    return await runTurn(client.as?.("subagent") ?? client, tools, messages, toolDefs, callbacks);
  } finally {
    callbacks.onSubagentDone?.(messages);
  }
}
