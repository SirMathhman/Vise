import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { classifyLine } from "../core/commands.ts";
import {
  compactIfNeeded,
  enabledTools,
  profileCommands,
  queueHookOutput,
  recordUsage,
  type Conversation,
  type Step,
} from "../core/compaction.ts";
import type {
  ChatMessage,
  ReasoningEffort,
  ReplyRequest,
  ToolCall,
  Usage,
} from "../core/messages.ts";
import {
  RUN_SUBAGENT,
  describeToolCall,
  parseSubagentArgs,
  sanitize,
  type Approve,
} from "../core/tools.ts";
import { queueApprovals, runSubagent, type SubagentPorts } from "./subagent.ts";
import type { Result } from "../core/result.ts";
import { err, ok } from "../core/result.ts";
import { runCommand, type ReplPorts } from "./commands.ts";

export type { ContextWindow, Reply } from "../core/messages.ts";
export type { ReplPorts } from "./commands.ts";

export async function* echoReply({
  messages,
}: ReplyRequest): AsyncGenerator<Result<string>> {
  yield ok(`echo: ${messages.at(-1)?.content ?? ""}`);
}

// The input lines, in order, held until they are read. `more` says whether another line
// can still arrive: false only once the input has ended and every line has been taken.
class InputLines {
  private queue: string[] = [];
  private ended = false;
  private waiting: ((line: string | undefined) => void) | undefined;

  push(line: string): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(line);
    } else {
      this.queue.push(line);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(undefined);
    }
  }

  // Drops lines typed before this point, so an answer must come after the question.
  discard(): void {
    this.queue = [];
  }

  get more(): boolean {
    return this.queue.length > 0 || !this.ended;
  }

  // Resolves with the next line, or undefined once the input has ended.
  next(): Promise<string | undefined> {
    const line = this.queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

// What one request to the model produced: its text, the calls it asked for, and its usage.
interface Round {
  answer: string;
  calls: ToolCall[];
  usage?: Usage;
  failure?: Error;
  // The reasoning items of the reply, kept to send back with its tool calls.
  reasoning?: unknown[];
}

// The thinking line of one request: rewritten in place while the model thinks, then replaced by the
// count. `width` is the length of the longest text written, so a shorter one clears the rest.
interface ThinkingView {
  shown: boolean;
  open: boolean;
  approximate: number;
  width: number;
}

// Ends the thinking line with the exact count when the provider reported one, or the estimate otherwise.
function finishThinking(
  output: Writable,
  view: ThinkingView,
  exact: number | undefined,
): void {
  if (!view.shown) return;
  const text =
    exact === undefined
      ? `thinking: ~${view.approximate} tokens`
      : `thinking: ${exact} tokens`;
  output.write(`${view.open ? "\r" : ""}${text.padEnd(view.width)}\n`);
  view.open = false;
}

// What one request of a turn needs: the history it sends, where the text goes, and the tools and
// thinking setting it uses.
interface RoundInput {
  history: ChatMessage[];
  reply(request: ReplyRequest): AsyncIterable<Result<string>>;
  output: Writable;
  offered: string[];
  reasoning: ReasoningEffort | undefined;
}

async function streamRound(input: RoundInput): Promise<Round> {
  const { history, reply, output, offered, reasoning } = input;
  const round: Round = { answer: "", calls: [] };
  const view: ThinkingView = {
    shown: false,
    open: false,
    approximate: 0,
    width: 0,
  };
  const onThinking = (approximate: number) => {
    // Thinking that comes after the answer has started is not shown; the model thinks first.
    if (round.answer !== "") return;
    const text = `thinking: ~${approximate} tokens`;
    view.shown = true;
    view.open = true;
    view.approximate = approximate;
    view.width = Math.max(view.width, text.length);
    output.write(`\r${text.padEnd(view.width)}`);
  };
  try {
    const request = {
      messages: history,
      onUsage: (usage: Usage) => {
        round.usage = usage;
      },
      onToolCall: (call: ToolCall) => {
        round.calls.push(call);
      },
      tools: offered,
      reasoning,
      onThinking,
      onReasoning: (items: unknown[]) => {
        round.reasoning = items;
      },
    };
    for await (const chunk of reply(request)) {
      if (!chunk.ok) {
        finishThinking(output, view, round.usage?.reasoningTokens);
        return { ...round, failure: chunk.error };
      }
      if (chunk.value !== "" && view.open) {
        output.write("\n");
        view.open = false;
      }
      round.answer += chunk.value;
      output.write(chunk.value);
    }
  } catch (error) {
    finishThinking(output, view, round.usage?.reasoningTokens);
    return {
      ...round,
      failure: error instanceof Error ? error : new Error(String(error)),
    };
  }
  finishThinking(output, view, round.usage?.reasoningTokens);
  return round;
}

// What running a round's tool calls needs from the session.
export interface CallsStep {
  calls: ToolCall[];
  tools(call: ToolCall, approve: Approve, offered: string[]): Promise<string>;
  approve(preview: string): Promise<boolean>;
  finished(): boolean;
  // The tools offered in this request. A call to another tool is refused by the runner.
  offered: string[];
  output: Writable;
  // What a subagent call needs from the session.
  subagents: SubagentPorts;
  // The tools switched off with /tools, which a subagent is not offered either.
  disabledTools: string[];
}

function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: "tool", toolCallId, content };
}

// Runs the calls of one round and returns their results, one tool message per call, in call order. A
// subagent call starts at once and runs alongside the others, and every approval goes through one
// queue. A call that is skipped because the session ended still gets a result.
async function runCalls(step: CallsStep): Promise<ChatMessage[]> {
  const approve = queueApprovals(step.approve);
  const results: Promise<ChatMessage>[] = [];
  for (const call of step.calls) {
    if (step.finished()) {
      step.output.write(
        `\n${sanitize(describeToolCall(call))} did not run: the session ended\n`,
      );
      results.push(
        Promise.resolve(
          toolMessage(
            call.id,
            "error: the call did not run because the session ended",
          ),
        ),
      );
      continue;
    }
    step.output.write(`\n${sanitize(describeToolCall(call))}\n`);
    if (call.name === RUN_SUBAGENT) {
      const args = parseSubagentArgs(call.arguments);
      const text = args.ok
        ? runSubagent(args.value, {
            ports: step.subagents,
            approve,
            finished: step.finished,
            output: step.output,
            disabledTools: step.disabledTools,
          })
        : Promise.resolve(`error: ${args.error.message}`);
      results.push(text.then((content) => toolMessage(call.id, content)));
      continue;
    }
    results.push(
      Promise.resolve(
        toolMessage(call.id, await step.tools(call, approve, step.offered)),
      ),
    );
  }
  return Promise.all(results);
}

// Hook output longer than this is cut short on the terminal. The whole output still goes to the model.
const HOOK_SHOWN_LIMIT = 4000;

// Shows a hook's output on the terminal, sanitized and cut short when it is long.
function showHookOutput(output: Writable, text: string): void {
  if (text === "") return;
  const shown = sanitize(text).slice(0, HOOK_SHOWN_LIMIT);
  output.write(
    `${shown}${text.length > HOOK_SHOWN_LIMIT ? "\n[output cut short]" : ""}\n`,
  );
}

// What one turn needs from the session.
export interface TurnContext {
  ports: ReplPorts;
  output: Writable;
  finished(): boolean;
  approve(preview: string): Promise<boolean>;
}

// What a turn leaves behind: the conversation to keep, and whether the session must stop.
export interface TurnResult {
  conversation: Conversation;
  stop: boolean;
}

// Runs one message as a turn. The turn-start hooks run first, and their output waits for the message;
// a failure of one stops this turn before it begins. The turn-end hooks run after the turn, whatever
// its outcome, and a failure of one stops the session.
async function runMessageTurn(
  text: string,
  conversation: Conversation,
  context: TurnContext,
): Promise<TurnResult> {
  const { ports, output, finished, approve } = context;
  const { reply, contextWindow, tools, instructions } = ports;
  const started = await ports.hooks(
    "turnStart",
    profileCommands(conversation, "turnStart"),
  );
  if (!started.ok) {
    output.write(`error: turn-start hook failed: ${started.error.message}\n`);
    return { conversation, stop: false };
  }
  showHookOutput(output, started.value);
  const compacted = await compactIfNeeded(
    queueHookOutput(conversation, started.value),
    reply,
    contextWindow,
  );
  if (compacted.notice) output.write(`${compacted.notice}\n`);
  let current = compacted.conversation;
  const turnStart = current.history.length;
  // The instructions go in front of the first user message, so roles still alternate and compaction
  // drops them with the rest of the old history. A pending profile and pending hook output go in
  // front of the message after them, and are kept until a turn succeeds.
  const first = current.history.length === 0 ? instructions : undefined;
  const profile = current.pendingProfile;
  const pending = current.pendingOutput;
  const parts = [first, profile, pending, text].filter(
    (part): part is string => part !== undefined,
  );
  current.history.push({ role: "user", content: parts.join("\n\n") });
  current = { ...current, pendingProfile: undefined, pendingOutput: undefined };
  // Each round asks the model. The first round answers the message just received; a round that
  // asked for tools is followed by another only while the session has not ended.
  for (;;) {
    const round = await streamRound({
      history: current.history,
      reply,
      output,
      offered: enabledTools(current),
      reasoning: current.thinking,
    });
    if (round.failure) {
      current.history.splice(turnStart);
      current = { ...current, pendingProfile: profile, pendingOutput: pending };
      output.write(`\nerror: ${round.failure.message}\n`);
      break;
    }
    current.history.push({
      role: "assistant",
      content: round.answer,
      toolCalls: round.calls.length > 0 ? round.calls : undefined,
      reasoning: round.calls.length > 0 ? round.reasoning : undefined,
    });
    // Only a completed request reports its size; a failed one leaves the stored size alone.
    if (round.usage) current = recordUsage(current, round.usage);
    if (round.calls.length === 0) {
      output.write("\n");
      break;
    }
    const results = await runCalls({
      calls: round.calls,
      tools,
      approve,
      finished,
      offered: enabledTools(current),
      output,
      subagents: ports,
      disabledTools: current.disabledTools ?? [],
    });
    current.history.push(...results);
    if (finished()) break;
  }
  const ended = await ports.hooks(
    "turnEnd",
    profileCommands(current, "turnEnd"),
  );
  if (!ended.ok) {
    output.write(`error: turn-end hook failed: ${ended.error.message}\n`);
    return { conversation: current, stop: true };
  }
  showHookOutput(output, ended.value);
  return { conversation: queueHookOutput(current, ended.value), stop: false };
}

// Runs the session until /exit or end of input. A failure of the input or output
// stream ends it early, and that failure is the result. Whatever happens, the
// interface is closed and the listeners are removed before this returns.
export async function runRepl(
  input: Readable,
  output: Writable,
  ports: ReplPorts,
): Promise<Result<void>> {
  let conversation: Conversation = {
    history: [],
    compacted: false,
    disabledTools: ports.disabledTools,
  };
  let streamError: Error | undefined;
  // Set when /exit is typed at an approval: the session ends and no further request is sent.
  let exitRequested = false;
  const lines = new InputLines();
  // Aborting closes the readline interface, which ends the loop below.
  const controller = new AbortController();
  const fail = (error: Error) => {
    streamError ??= error;
    controller.abort();
  };
  input.on("error", fail);
  output.on("error", fail);
  const rl = createInterface({
    input,
    output,
    prompt: "> ",
    signal: controller.signal,
  });
  // Readline re-emits input errors on the interface, and throws if nothing listens.
  rl.on("error", fail);
  rl.on("line", (line) => lines.push(line));
  rl.once("close", () => lines.end());
  // Once the session has ended for good, nothing else runs: no tool, no request, no approval.
  // Queued lines do not count, because a stream failure or /exit ends the session even with
  // lines waiting, and input that has ended with nothing queued cannot answer anything.
  const finished = () =>
    exitRequested || streamError !== undefined || !lines.more;
  // A change is written only when the user answers y. The answer must come after the preview,
  // so lines typed before it are dropped. Ending input, /exit, or any other answer refuses it;
  // /exit also ends the session.
  const approve: Approve = async (preview) => {
    if (exitRequested || streamError !== undefined) return false;
    lines.discard();
    output.write(`${sanitize(preview)}\napply? (y/n) `);
    const line = await lines.next();
    if (line === undefined) return false;
    if (line.trim() === "/exit") {
      exitRequested = true;
      return false;
    }
    return /^y(es)?$/i.test(line.trim());
  };
  const apply = (step: Step) => {
    conversation = step.conversation;
    if (step.notice) output.write(`${step.notice}\n`);
  };
  try {
    rl.prompt();
    // A session-start hook that fails stops the session. Its prompt has already been written.
    const started = await ports.hooks(
      "sessionStart",
      profileCommands(conversation, "sessionStart"),
    );
    if (!started.ok) return err(started.error);
    conversation = queueHookOutput(conversation, started.value);
    showHookOutput(output, started.value);
    for (
      let line = await lines.next();
      line !== undefined && !exitRequested && streamError === undefined;
      line = await lines.next()
    ) {
      const input = classifyLine(line);
      if (input.kind === "exit") break;
      if (input.kind !== "message") {
        const step = await runCommand(input, ports, output, conversation);
        if (step) apply(step);
        rl.prompt();
        continue;
      }
      const turn = await runMessageTurn(input.text, conversation, {
        ports,
        output,
        finished,
        approve,
      });
      conversation = turn.conversation;
      if (turn.stop) break;
      if (exitRequested || streamError !== undefined) break;
      rl.prompt();
    }
    const ended = await ports.hooks(
      "sessionEnd",
      profileCommands(conversation, "sessionEnd"),
    );
    if (ended.ok) showHookOutput(output, ended.value);
    else
      output.write(`error: session-end hook failed: ${ended.error.message}\n`);
  } finally {
    input.off("error", fail);
    output.off("error", fail);
    rl.close();
  }
  return streamError ? err(streamError) : ok(undefined);
}
