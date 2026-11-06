import type { ChatMessage, ContextWindow, Reply, Usage } from "./messages.ts";
import { err, ok, type Result } from "./result.ts";
import { toolNames } from "./tools.ts";

const KEEP_RECENT = 6;
const COMPACT_REQUEST = "Summarize this convo";
const COMPACT_AT = 0.8;

// What the frontend keeps between messages. promptTokens is the size the model
// reported for the last completed request. compacted is true from a compaction
// until a request reports a size again.
export interface Conversation {
  history: ChatMessage[];
  promptTokens?: number;
  compacted: boolean;
  // The profile in use, if any. Its text is sent once, with the next message.
  profile?: ActiveProfile;
  pendingProfile?: string;
  // Tools switched off by the user. Every other tool is offered to the model.
  disabledTools?: string[];
  // Output of hooks that has not been sent yet. It goes in front of the next user message.
  pendingOutput?: string;
}

// The points at which a hook runs: before and after a session, and before and after a turn.
export type HookPoint = "sessionStart" | "sessionEnd" | "turnStart" | "turnEnd";

// Runs the hooks of one point and returns their output. A failure is an error.
export type HookRunner = (point: HookPoint) => Promise<Result<string>>;

// Adds hook output to the output waiting for the next message. Empty output changes nothing.
export function queueHookOutput(conversation: Conversation, output: string): Conversation {
  if (output === "") return conversation;
  const pendingOutput = conversation.pendingOutput === undefined ? output : `${conversation.pendingOutput}\n\n${output}`;
  return { ...conversation, pendingOutput };
}

// The tools offered to the model: every tool that is switched on, and, when the active profile has
// a whitelist, that is on the whitelist too. Both must allow a tool.
export function enabledTools(conversation: Conversation): string[] {
  const disabled = conversation.disabledTools ?? [];
  const allowed = conversation.profile?.tools;
  return toolNames.filter((name) => !disabled.includes(name) && (allowed === undefined || allowed.includes(name)));
}

// Switches one tool on or off. The change applies from the next request.
export function setToolEnabled(conversation: Conversation, name: string, enabled: boolean): Step {
  const others = (conversation.disabledTools ?? []).filter((tool) => tool !== name);
  const disabledTools = enabled ? others : [...others, name];
  return {
    conversation: { ...conversation, disabledTools },
    notice: `tool ${name} ${enabled ? "on" : "off"}`,
  };
}

export interface ActiveProfile {
  name: string;
  text: string;
  // The tools the profile allows. Absent when it has no whitelist.
  tools?: string[];
}

// A transition's result: the conversation to keep, and a line to show the user, if any.
export interface Step {
  conversation: Conversation;
  notice?: string;
}

// The history sent to the model to produce a summary: the whole history, then the request.
export function compactionRequest(history: ChatMessage[]): ChatMessage[] {
  return [...history, { role: "user", content: COMPACT_REQUEST }];
}

// The new history: the summary, then the most recent messages from the first user message
// on, so the kept messages never begin with a tool result. If that first user message is
// kept, the summary is merged into it so roles alternate.
export function compactedHistory(summary: string, history: ChatMessage[]): ChatMessage[] {
  const recent = history.slice(-KEEP_RECENT);
  const start = recent.findIndex((message) => message.role === "user");
  const [first, ...rest] = start < 0 ? [] : recent.slice(start);
  if (first?.role === "user") {
    return [{ role: "user", content: `${summary}\n\n${first.content}` }, ...rest];
  }
  return [{ role: "user", content: summary }];
}

// True when the last prompt used most of the model's context window.
export function needsCompaction(promptTokens: number, contextLength: number): boolean {
  return promptTokens >= contextLength * COMPACT_AT;
}

// Replaces the history with a summary of it. On failure the conversation is returned
// unchanged inside the err, so the caller keeps what it had.
export async function compact(conversation: Conversation, reply: Reply): Promise<Result<Conversation>> {
  if (conversation.history.length === 0) return err(new Error("nothing to compact"));
  let summary = "";
  try {
    for await (const chunk of reply(compactionRequest(conversation.history), () => {}, () => {}, enabledTools(conversation))) {
      if (!chunk.ok) return chunk;
      summary += chunk.value;
    }
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  // The compacted history no longer holds the profile text, so the active profile is sent again
  // with the next message.
  return ok({
    ...conversation,
    history: compactedHistory(summary, conversation.history),
    promptTokens: undefined,
    compacted: true,
    pendingProfile: conversation.profile?.text,
  });
}

// Keeps the size of a completed request. A compaction is not needed to read it.
export function recordUsage(conversation: Conversation, usage: Usage): Conversation {
  return { ...conversation, promptTokens: usage.promptTokens, compacted: false };
}

// Makes a profile the active one. Its text is pending until the next message carries it.
export function useProfile(conversation: Conversation, profile: ActiveProfile): Step {
  return {
    conversation: { ...conversation, profile, pendingProfile: profile.text },
    notice: `profile: ${profile.name}`,
  };
}

// Turns profiles off. Text already in the history stays there.
export function clearProfile(conversation: Conversation): Step {
  return {
    conversation: { ...conversation, profile: undefined, pendingProfile: undefined },
    notice: "profile: default",
  };
}

// Compacts because the user asked for it (/compact).
export async function compactNow(conversation: Conversation, reply: Reply): Promise<Step> {
  const result = await compact(conversation, reply);
  if (result.ok) return { conversation: result.value, notice: "history compacted" };
  return { conversation, notice: `error: compaction failed: ${result.error.message}` };
}

// Compacts before a message when the last prompt used most of the window. Without a
// size from a completed request there is nothing to compare, so nothing happens.
export async function compactIfNeeded(
  conversation: Conversation,
  reply: Reply,
  contextWindow: ContextWindow,
): Promise<Step> {
  if (conversation.promptTokens === undefined) return { conversation };
  const window = await contextWindow();
  if (!window.ok) {
    return { conversation, notice: `error: could not check the context window: ${window.error.message}` };
  }
  if (!needsCompaction(conversation.promptTokens, window.value)) return { conversation };
  return compactNow(conversation, reply);
}
