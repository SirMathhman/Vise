import type { GoalTraceEntry } from "../core/goal-trace.ts";

/** How much of a question, reply or note `/goal log` shows (the whole text is in the saved session). */
const SHOWN = 300;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SHOWN ? flat : `${flat.slice(0, SHOWN)}… (${flat.length - SHOWN} more)`;
}

/** One entry as indented lines. */
function lines(e: GoalTraceEntry): string[] {
  switch (e.kind) {
    case "setting":
      return [`goal checking switched ${e.enabled ? "on" : "off"}`];
    case "turn_start":
      return [
        `turn started, goal checking ${e.enabled ? "on" : "off"}${e.goal ? `, carried goal: ${clip(e.goal)}` : ""}`,
        `  user: ${clip(e.line)}`,
      ];
    case "ask":
      return [
        `ask ${e.purpose} (attempt ${e.attempt})${e.failure ? `, FAILED: ${clip(e.failure)}` : ""}`,
        `  question: ${clip(e.question)}`,
        ...(e.reply === undefined ? [] : [`  reply: ${clip(e.reply)}`]),
      ];
    case "goal":
      return [
        `goal${e.fallback ? " (the user's own words: the derivation gave nothing usable)" : ""}: ${clip(e.goal)}`,
        `  done when: ${clip(e.doneWhen)}${e.previous ? `; previous goal: ${clip(e.previous)}` : ""}`,
      ];
    case "verdict":
      return [`verdict ${e.verdict}: ${clip(e.detail)}`];
    case "progress":
      return [
        `progress ${e.progress}: ${clip(e.detail)}${e.keepGoing === undefined ? "" : e.keepGoing ? " (the user said keep going)" : " (the user said stop)"}`,
      ];
    case "continue":
      return [
        `continue ${e.continues} (same step repeated ${e.repeats}x, tools ran since last: ${e.toolsRan ? "yes" : "no"})`,
        `  note: ${clip(e.note)}`,
      ];
    case "exit":
      return [
        `EXIT ${e.reason}${e.detail ? `: ${clip(e.detail)}` : ""}`,
        `  model's last reply: ${e.lastReply === "" ? "(none)" : clip(e.lastReply)}`,
        `  tool results this turn: ${e.toolResults}`,
      ];
  }
}

/**
 * The goal trace as text for `/goal log`: one block per turn (each starts at
 * its `turn_start` and ends at its `exit`), oldest first. `turns` limits it to
 * the last few turns.
 */
export function formatGoalTrace(
  entries: GoalTraceEntry[],
  turns?: number,
): string {
  if (entries.length === 0) {
    return "no goal trace yet (it is recorded while goal checking is on)";
  }
  const blocks: GoalTraceEntry[][] = [];
  for (const entry of entries) {
    if (entry.kind === "turn_start" || blocks.length === 0) blocks.push([]);
    blocks[blocks.length - 1]?.push(entry);
  }
  const shown = turns === undefined ? blocks : blocks.slice(-turns);
  const first = blocks.length - shown.length;
  return shown
    .map((block, i) => {
      const head = block[0];
      const title = `--- turn ${first + i + 1}${head ? `, ${head.at}, after ${head.after} messages` : ""} ---`;
      const body = block.flatMap((e) => lines(e).map((l, n) => (n === 0 ? `${e.at.slice(11, 19)} ${l}` : `         ${l}`)));
      return [title, ...body].join("\n");
    })
    .join("\n\n");
}
