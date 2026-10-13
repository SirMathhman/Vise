import type { Message } from "../errors.ts";

/**
 * The user's own words, kept verbatim through compaction. A summary is the
 * model's paraphrase of a conversation and can lose a standing instruction
 * ("don't submit, I want to look it over"); these lines are copied, not
 * paraphrased, and appended after the summary. Pure.
 */

/** The text every compaction summary starts with (and `isSummaryFrame` recognises). */
export const SUMMARY_FRAME_PREFIX = "Here is a summary of our conversation so far:";

/** The heading of the pinned block at the end of a summary frame. */
export const PIN_HEADING = "The user's own words so far (verbatim, oldest first):";

/** One pinned line is cut to this many characters. */
export const PIN_LINE_MAX = 400;

/** All pinned lines together stay within this many characters; the newest are kept. */
export const PIN_TOTAL_MAX = 4000;

const OMITTED = "(earlier lines omitted)";

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Whether a message is the frame a previous compaction left. */
export function isSummaryFrame(m: Message): boolean {
  return m.role === "user" && m.content.startsWith(SUMMARY_FRAME_PREFIX);
}

/** The lines of the pin block inside a summary frame, in order (none when it has no block). */
export function parsePins(frame: string): string[] {
  const at = frame.lastIndexOf(PIN_HEADING);
  if (at < 0) return [];
  return frame
    .slice(at + PIN_HEADING.length)
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

/** Whether a user message is something the user said (not a notice or a frame the session added). */
function isUserWords(m: Message, anyTyped: boolean): boolean {
  if (m.role !== "user" || isSummaryFrame(m)) return false;
  if (anyTyped) return m.typed === true;
  // Saved before the `typed` mark: everything but bracketed notices.
  return !m.content.trimStart().startsWith("[");
}

/**
 * The user's words in `messages`, oldest first: every typed line and every
 * answer given to `ask_user`, plus the pins an earlier compaction carried (so
 * they pass through repeated compactions unchanged). Duplicates are dropped.
 */
export function pinUserWords(messages: Message[]): string[] {
  const anyTyped = messages.some((m) => m.typed === true);
  const askIds = new Set<string>();
  const lines: string[] = [];
  for (const m of messages) {
    if (isSummaryFrame(m)) {
      lines.push(...parsePins(m.content));
    } else if (m.role === "assistant") {
      for (const call of m.tool_calls ?? []) {
        if (call.function.name === "ask_user") askIds.add(call.id);
      }
    } else if (m.role === "tool" && m.tool_call_id && askIds.has(m.tool_call_id)) {
      lines.push(`(answer to a question) ${flat(m.content).replace(/^user replied:\s*/i, "")}`);
    } else if (isUserWords(m, anyTyped)) {
      lines.push(flat(m.content));
    }
  }
  const seen = new Set<string>();
  return lines
    .filter((l) => l !== "" && !seen.has(l) && seen.add(l))
    .map((l) => (l.length > PIN_LINE_MAX ? `${l.slice(0, PIN_LINE_MAX)}…` : l));
}

/** The block appended to a summary: the heading and the lines, newest kept when over the total. */
export function renderPins(lines: string[]): string {
  if (lines.length === 0) return "";
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (used + line.length > PIN_TOTAL_MAX && kept.length > 0) {
      kept.push(OMITTED);
      break;
    }
    kept.push(line);
    used += line.length;
  }
  const ordered = kept.reverse().map((l) => (l === OMITTED ? l : `- ${l}`));
  return `${PIN_HEADING}\n${ordered.join("\n")}`;
}
