import { config } from "../config.ts";
import type { Message } from "../core/errors.ts";
import { formatToolCall } from "../output/tool-line.ts";
import { displayOfTool } from "../tools/display.ts";

/**
 * A saved conversation as the lines the web page shows when it restores it:
 * what the user typed (with the pictures they attached), what the agent
 * said, the tool calls it made and the pictures they produced. Everything the
 * session put into the conversation itself (the directory tree, notices, a
 * profile's text, hook output) is left out.
 */
type EntryBody =
  | { kind: "user"; text: string; images: { id: string; label: string }[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; text: string }
  | { kind: "image"; id: string; label: string }
  | { kind: "note"; text: string };

/**
 * `seq` is the entry's position among all the lines of the conversation (0 is
 * the first), the same whether or not the earlier ones are sent, so a page can
 * ask for "the lines before seq N". The note that stands for the lines left out
 * has `seq` -1.
 */
export type HistoryEntry = EntryBody & { seq: number };

/** The most lines restored at once; older ones are summarised as a count. */

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
  const bodies: EntryBody[] = [];
  messages.forEach((m, index) => {
    if (m.role === "user" && typedByUser(m, index, marked)) {
      bodies.push({
        kind: "user",
        text: m.content,
        images: (m.images ?? []).map((i) => ({ id: i.id, label: i.label })),
      });
    } else if (m.role === "assistant") {
      const text = m.content.replace(PLAN, "").trim();
      if (text) bodies.push({ kind: "assistant", text });
      for (const call of m.tool_calls ?? []) {
        const args = parseArgs(call.function.arguments);
        bodies.push({
          kind: "tool",
          name: call.function.name,
          text: formatToolCall(call.function.name, args, displayOfTool),
        });
      }
    } else if (m.role === "tool") {
      for (const image of m.images ?? []) {
        bodies.push({ kind: "image", id: image.id, label: image.label });
      }
    }
  });
  const entries: HistoryEntry[] = bodies.map((body, seq) => ({ ...body, seq }));
  if (entries.length <= config.historyMaxEntries) return entries;
  const cut = entries.length - config.historyMaxEntries;
  return [
    { kind: "note", text: `(${cut} earlier lines are not shown)`, seq: -1 },
    ...entries.slice(cut),
  ];
}
