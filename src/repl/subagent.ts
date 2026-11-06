import type { Writable } from "node:stream";
import { enabledTools, profileCommands, type Conversation, type HookRunner } from "../core/compaction.ts";
import type { ChatMessage, Reply, ToolCall } from "../core/messages.ts";
import type { ProfileHook, ProfileLoader } from "../core/notes.ts";
import type { Result } from "../core/result.ts";
import { RUN_SUBAGENT, type Approve, type SubagentArgs, type ToolRunner } from "../core/tools.ts";

// What a subagent needs from the session. The session's ports satisfy it.
export interface SubagentPorts {
  reply: Reply;
  tools: ToolRunner;
  hooks: HookRunner;
  profile: ProfileLoader;
  profileTools: (name: string) => Promise<Result<string[] | undefined>>;
  profileHooks: (name: string) => Promise<Result<ProfileHook[]>>;
}

export interface SubagentContext {
  ports: SubagentPorts;
  // Already queued, so subagents and the main conversation ask one question at a time.
  approve: Approve;
  finished: () => boolean;
  output: Writable;
  // The tools switched off with /tools. A subagent is offered none of them.
  disabledTools: string[];
}

// Approvals go one at a time, in the order they are asked, so two questions never overlap at the
// terminal. Every approval in a round must go through the same queue.
export function queueApprovals(approve: Approve): Approve {
  // The last question still open, if any. A question with nothing open is asked at once.
  let open: Promise<unknown> | undefined;
  return (preview) => {
    const asked = open === undefined ? approve(preview) : open.then(() => approve(preview));
    const settled = asked.then(
      () => undefined,
      () => undefined,
    );
    open = settled;
    void settled.then(() => {
      if (open === settled) open = undefined;
    });
    return asked;
  };
}

interface SubRound {
  answer: string;
  calls: ToolCall[];
  failure?: Error;
}

// One request to the model, with its text and the calls it asked for. A failure is returned, not thrown.
async function collectRound(reply: Reply, history: ChatMessage[], offered: string[]): Promise<SubRound> {
  const round: SubRound = { answer: "", calls: [] };
  try {
    for await (const chunk of reply(
      history,
      () => {},
      (call) => {
        round.calls.push(call);
      },
      offered,
      undefined,
      () => {},
    )) {
      if (!chunk.ok) return { ...round, failure: chunk.error };
      round.answer += chunk.value;
    }
  } catch (error) {
    return { ...round, failure: error instanceof Error ? error : new Error(String(error)) };
  }
  return round;
}

// Runs one subagent: its profile's text and the task as its first message, then its rounds. It may
// make at most `maxToolCalls` tool calls. When it reaches the limit, it is asked once more with no
// tools, and its answer is marked as cut short. The result is the text the main model receives.
export async function runSubagent(args: SubagentArgs, context: SubagentContext): Promise<string> {
  const { ports, approve, finished, output, disabledTools } = context;
  const fail = (message: string) => {
    output.write(`subagent ${args.profile}: failed\n`);
    return `error: ${message}`;
  };
  const text = await ports.profile(args.profile);
  if (!text.ok) return fail(text.error.message);
  const allowed = await ports.profileTools(args.profile);
  if (!allowed.ok) return fail(allowed.error.message);
  if (allowed.value === undefined) return fail(`profile ${args.profile} lists no tools, so it cannot run a subagent`);
  const hooks = await ports.profileHooks(args.profile);
  if (!hooks.ok) return fail(hooks.error.message);
  const conversation: Conversation = {
    history: [],
    compacted: false,
    profile: { name: args.profile, text: text.value, tools: allowed.value, hooks: hooks.value },
    disabledTools,
  };
  // A subagent is never offered the subagent tool, so it cannot start another one.
  const offered = enabledTools(conversation).filter((name) => name !== RUN_SUBAGENT);
  output.write(`subagent ${args.profile}: started\n`);
  const started = await ports.hooks("turnStart", profileCommands(conversation, "turnStart"));
  if (!started.ok) return fail(`turn-start hook failed: ${started.error.message}`);
  const parts = [started.value, text.value, args.task].filter((part) => part !== "");
  const history: ChatMessage[] = [{ role: "user", content: parts.join("\n\n") }];
  let calls = 0;
  let answer: string;
  let cut = false;
  for (;;) {
    const round = await collectRound(ports.reply, history, offered);
    if (round.failure) return fail(round.failure.message);
    history.push({ role: "assistant", content: round.answer, toolCalls: round.calls.length > 0 ? round.calls : undefined });
    if (round.calls.length === 0) {
      answer = round.answer;
      break;
    }
    for (const call of round.calls) {
      if (finished()) {
        history.push({ role: "tool", toolCallId: call.id, content: "error: the call did not run because the session ended" });
        continue;
      }
      if (calls >= args.maxToolCalls) {
        history.push({ role: "tool", toolCallId: call.id, content: "error: the tool call limit was reached" });
        continue;
      }
      calls += 1;
      history.push({ role: "tool", toolCallId: call.id, content: await ports.tools(call, approve, offered) });
    }
    if (finished()) {
      answer = round.answer;
      break;
    }
    if (calls >= args.maxToolCalls) {
      cut = true;
      const last = await collectRound(ports.reply, history, []);
      if (last.failure) return fail(last.failure.message);
      history.push({ role: "assistant", content: last.answer, toolCalls: undefined });
      answer = last.answer;
      break;
    }
  }
  const ended = await ports.hooks("turnEnd", profileCommands(conversation, "turnEnd"));
  if (!ended.ok) output.write(`subagent ${args.profile}: turn-end hook failed: ${ended.error.message}\n`);
  output.write(`subagent ${args.profile}: finished after ${calls} tool calls${cut ? " (cut short)" : ""}\n`);
  return cut ? `[cut short after ${calls} tool calls]\n${answer}` : answer;
}
