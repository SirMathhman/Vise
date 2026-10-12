import { collectLists } from "@vise/backend";
import type { EdgeSession } from "@vise/backend";

/**
 * Push the page's lists (profiles, tools, reasoning levels, saved sessions,
 * burst state) as one `lists` message. A pure read, so it is never queued
 * behind a turn; the page asks with `lists_get` when it connects, and the
 * server pushes it again after every line, so a command's effect shows without
 * the page parsing the command's text.
 *   server → browser: { type:"lists", lists: { profiles?, tools?, reasoning?, sessions?, burst, errors } }
 */
export async function sendLists(
  edge: EdgeSession,
  send: (msg: Record<string, unknown>) => void,
): Promise<void> {
  const snapshot = await collectLists({
    profileSource: edge.profileSource,
    activeProfile: edge.session.getActiveProfile(),
    toolController: edge.toolController,
    reasoning: edge.reasoning,
    sessionSource: edge.sessionSource,
    burst: edge.session.isBurst(),
  });
  send({ type: "lists", lists: snapshot });
}
