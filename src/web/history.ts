import type { Message } from "../core/errors.ts";
import { formatToolCall } from "../output/tool-line.ts";

/**
 * A saved conversation as the lines the web page shows when it restores it:
 * what the user typed (with the pictures they attached), what the agent
 * said, the tool calls it made and the pictures they produced. Everything the
 * session put into the conversation itself (the directory tree, notices, a
 * profile's text, hook output) is left out.
 */
export type HistoryEntry =
  | { kind: "user"; text: string; images: { id: string; label: string }[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; text: string }
  | { kind: "image"; id: string; label: string }
  | { kind: "note"; text: string };

/** The most lines restored at once; older ones are summarised as a count. */
const MAX_ENTRIES = 400;

/** The burst-mode plan the engine puts in front of an assistant message is not something to show. */
const PLAN = /^<plan>[\s\S]*?<\/plan>\n?/;

function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a user-role message is something the user typed. Sessions saved
 * since messages carry the mark use it; older ones are told by what the
 * session itself writes: the opening context (the first message) and
 * bracketed notices.
 */
function typedByUser(
  message: Message,
  index: number,
  marked: boolean,
): boolean {
  if (marked) return message.typed === true;
  return index > 0 && !message.content.startsWith("[");
}

export function historyEntries(messages: Message[]): HistoryEntry[] {
  const marked = messages.some((m) => m.typed === true);
  const entries: HistoryEntry[] = [];
  messages.forEach((m, index) => {
    if (m.role === "user" && typedByUser(m, index, marked)) {
      entries.push({
        kind: "user",
        text: m.content,
        images: (m.images ?? []).map((i) => ({ id: i.id, label: i.label })),
      });
    } else if (m.role === "assistant") {
      const text = m.content.replace(PLAN, "").trim();
      if (text) entries.push({ kind: "assistant", text });
      for (const call of m.tool_calls ?? []) {
        const args = parseArgs(call.function.arguments);
        entries.push({
          kind: "tool",
          name: call.function.name,
          text: formatToolCall(call.function.name, args),
        });
      }
    } else if (m.role === "tool") {
      for (const image of m.images ?? []) {
        entries.push({ kind: "image", id: image.id, label: image.label });
      }
    }
  });
  if (entries.length <= MAX_ENTRIES) return entries;
  const cut = entries.length - MAX_ENTRIES;
  return [
    { kind: "note", text: `(${cut} earlier lines are not shown)` },
    ...entries.slice(cut),
  ];
}
