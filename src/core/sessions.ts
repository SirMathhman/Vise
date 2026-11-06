import { z } from "zod";
import type { Conversation } from "./compaction.ts";
import type { ChatMessage } from "./messages.ts";
import { checkName } from "./notes.ts";
import { err, ok, type Result } from "./result.ts";
import { toolNames } from "./tools.ts";

// A saved session is the conversation as JSON, with a version so the format can change later.
const SESSION_VERSION = 1;

// Reads a session file. It is checked before use, because it may have been edited by hand.
const SessionSchema = z
  .object({
    version: z.literal(SESSION_VERSION),
    history: z.array(
      z.discriminatedUnion("role", [
        z.object({ role: z.literal("user"), content: z.string() }),
        z.object({
          role: z.literal("assistant"),
          content: z.string(),
          toolCalls: z
            .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
            .optional(),
        }),
        z.object({ role: z.literal("tool"), toolCallId: z.string(), content: z.string() }),
      ]),
    ),
    promptTokens: z.number().optional(),
    compacted: z.boolean(),
    profile: z.object({ name: z.string(), text: z.string() }).optional(),
    pendingProfile: z.string().optional(),
    disabledTools: z.array(z.string()).optional(),
  })
  .refine((session) => (session.disabledTools ?? []).every((name) => toolNames.includes(name)), {
    message: "a switched-off tool does not exist",
  });

// Where saved sessions are read and written. The composition root supplies it.
export interface SessionStore {
  save(name: string, text: string): Promise<Result<void>>;
  load(name: string): Promise<Result<string>>;
  list(): Promise<Result<string[]>>;
}

export interface SaveSessionCommand {
  kind: "save";
  name: string;
}

export interface LoadSessionCommand {
  kind: "load";
  name: string;
}

export interface ListSessionsCommand {
  kind: "list";
}

export type SessionCommand = SaveSessionCommand | LoadSessionCommand | ListSessionsCommand;

// Reads the words of a session command: /save <name>, /load <name>, or /sessions.
export function parseSessionCommand(words: string[]): Result<SessionCommand> {
  const [action, name] = words;
  if (action === "sessions" && words.length === 1) return ok({ kind: "list" });
  if ((action === "save" || action === "load") && words.length === 2 && name !== undefined) {
    const checked = checkName(name, "session name");
    if (!checked.ok) return checked;
    if (action === "save") return ok({ kind: "save", name: checked.value });
    return ok({ kind: "load", name: checked.value });
  }
  return err(new Error("usage: /save <name> | /load <name> | /sessions"));
}

// The text of a session file: the conversation's history and the state that goes with it.
export function encodeSession(conversation: Conversation): string {
  const saved = {
    version: SESSION_VERSION,
    history: conversation.history,
    promptTokens: conversation.promptTokens,
    compacted: conversation.compacted,
    profile: conversation.profile,
    pendingProfile: conversation.pendingProfile,
    disabledTools: conversation.disabledTools,
  };
  return `${JSON.stringify(saved, null, 2)}\n`;
}

// Every tool call must be answered by a tool message with its id, and every tool message must answer
// a call made just before it. Returns the first message that breaks this, or ok.
export function checkPairing(history: ChatMessage[]): Result<void> {
  let pending = new Set<string>();
  for (const [index, message] of history.entries()) {
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId)) {
        return err(new Error(`message ${index + 1} is a tool result with no call before it`));
      }
      continue;
    }
    if (pending.size > 0) {
      return err(new Error(`message ${index + 1} comes before the results of the calls before it`));
    }
    pending = new Set(message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : []);
  }
  if (pending.size > 0) return err(new Error("the last tool calls have no results"));
  return ok(undefined);
}

// Reads a session file back into a conversation. A file that is not JSON, does not match the
// format, or has a tool call and result that do not pair, is refused and nothing is loaded.
export function decodeSession(text: string): Result<Conversation> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error("the session file is not JSON"));
  }
  const parsed = SessionSchema.safeParse(value);
  if (!parsed.success) return err(new Error("the session file does not match the session format"));
  const session = parsed.data;
  const paired = checkPairing(session.history);
  if (!paired.ok) return err(paired.error);
  return ok({
    history: session.history,
    promptTokens: session.promptTokens,
    compacted: session.compacted,
    profile: session.profile,
    pendingProfile: session.pendingProfile,
    disabledTools: session.disabledTools,
  });
}
