import { steerLine, unqueue } from "./line.ts";
import type { LineConnection } from "./line.ts";

/**
 * `/steer <text>` and `/queue [clear|remove <n>]` typed in the page. They act
 * on the connection directly, never behind the turn they are meant to affect.
 * Returns false when the line is not one of them.
 */
export function handleQueueCommand(conn: LineConnection, line: string): boolean {
  const match = /^\/(steer|queue)(?:\s+(.*))?$/s.exec(line.trim());
  if (!match) return false;
  const [, command, rest = ""] = match;
  const say = (text: string): void => conn.send({ type: "notice", text });
  if (command === "steer") {
    if (rest.trim()) steerLine(conn, rest.trim(), undefined);
    else say("usage: /steer <message> (sent to the agent before its next step)");
    return true;
  }
  const arg = rest.trim();
  if (arg === "clear") {
    say(`removed ${unqueue(conn)} queued message(s)`);
  } else if (arg.startsWith("remove")) {
    const item = conn.held[Number(arg.slice(6).trim()) - 1];
    say(item && unqueue(conn, item.qid) ? "removed" : "no such queued message");
  } else if (arg) {
    say("usage: /queue | /queue clear | /queue remove <number>");
  } else if (conn.held.length === 0) {
    say("nothing is queued");
  } else {
    say(
      `queued (run in order after the current task):\n${conn.held
        .map((h, i) => `${i + 1}. ${h.text}`)
        .join("\n")}`,
    );
  }
  return true;
}
