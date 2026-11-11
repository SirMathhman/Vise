import type { ChatMessage, ToolCall } from "../core/messages.ts";
import { describeToolCall } from "../core/tool-lines.ts";
import { ASK_USER, RUN_SUBAGENT, parseAskArgs, parseSubagentArgs, type Approve, type AskArgs } from "../core/tools.ts";
import type { Emit } from "../protocol/protocol.ts";
import { queueApprovals, runSubagent, type SubagentPorts } from "./subagent/subagent.ts";

// What running a round's tool calls needs from the session.
export interface CallsStep {
  calls: ToolCall[];
  tools(call: ToolCall, approve: Approve, offered: string[]): Promise<string>;
  approve(preview: string): Promise<boolean>;
  // Asks the user a question, for ask_user. The calls of the round wait for the answer.
  ask(args: AskArgs): Promise<string>;
  finished(): boolean;
  // The tools offered in this request. A call to another tool is refused by the runner.
  offered: string[];
  emit: Emit;
  // What a subagent call needs from the session.
  subagents: SubagentPorts;
  // The tools switched off with /tools, which a subagent is not offered either.
  disabledTools: string[];
}

// The tools the backend runs itself. The runner does not see them, so the offered check is made here too.
const BACKEND_TOOLS: string[] = [RUN_SUBAGENT, ASK_USER];

export function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: "tool", toolCallId, content };
}

// Runs the calls of one round and returns their results, one tool message per call, in call order. A
// subagent call starts at once and runs alongside the others, and every approval goes through one
// queue. A call that is skipped because the session ended still gets a result.
export async function runCalls(step: CallsStep): Promise<ChatMessage[]> {
  const approve = queueApprovals(step.approve);
  const results: Promise<ChatMessage>[] = [];
  for (const call of step.calls) {
    const description = describeToolCall(call);
    if (step.finished()) {
      step.emit({ kind: "toolSkipped", id: call.id, description });
      results.push(
        Promise.resolve(
          toolMessage(call.id, "error: the call did not run because the session ended"),
        ),
      );
      continue;
    }
    step.emit({ kind: "toolCall", id: call.id, description });
    // A tool that is switched off, or left out by the profile, is refused before anyone is asked.
    if (BACKEND_TOOLS.includes(call.name) && !step.offered.includes(call.name)) {
      results.push(Promise.resolve(toolMessage(call.id, `error: tool ${call.name} is switched off`)));
      continue;
    }
    if (call.name === ASK_USER) {
      const args = parseAskArgs(call.arguments);
      const text = args.ok ? await step.ask(args.value) : `error: ${args.error.message}`;
      results.push(Promise.resolve(toolMessage(call.id, text)));
      continue;
    }
    if (call.name === RUN_SUBAGENT) {
      const args = parseSubagentArgs(call.arguments);
      const text = args.ok
        ? runSubagent(args.value, {
            ports: step.subagents,
            approve,
            finished: step.finished,
            emit: step.emit,
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
  const messages = await Promise.all(results);
  for (const message of messages) {
    if (message.role === "tool") step.emit({ kind: "toolResult", id: message.toolCallId, text: capped(message.content) });
  }
  return messages;
}

// The most of a result the page is sent. The rest is still in the conversation the model sees.
const RESULT_CHARS = 4000;

function capped(text: string): string {
  return text.length <= RESULT_CHARS ? text : `${text.slice(0, RESULT_CHARS)}
[${text.length - RESULT_CHARS} more characters not shown]`;
}
