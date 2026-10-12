import type { CallPurpose, GenerationProgress } from "@vise/core";
import { CALL_CLOSE, CALL_OPEN } from "../tool-protocol.ts";

/** How often a long generation is reported: every this many tokens, or this many milliseconds. */
const EVERY_TOKENS = 20;
const EVERY_MS = 250;

/** The name of the tool whose call is being written, read from the end of the text so far; undefined outside a call. */
export function toolBeingCalled(tail: string): string | undefined {
  if (tail.lastIndexOf(CALL_OPEN) <= tail.lastIndexOf(CALL_CLOSE))
    return undefined;
  const names = [...tail.matchAll(/"name"\s*:\s*"([A-Za-z0-9_]+)"/g)];
  return names[names.length - 1]?.[1];
}

/**
 * Reports how much a model call has generated so far, so a long reply or a
 * long tool call (500 lines of a file, say) is visibly in progress even though
 * its text is hidden from the page: `tokens` is the server's own count, `text`
 * is fed what streams so that the tool being called can be named.
 */
export function generationReporter(
  sink: (progress: GenerationProgress) => void,
  request: number,
  purpose: CallPurpose,
  now: () => number = Date.now,
): { text(piece: string): void; tokens(count: number): void; done(): void } {
  let tail = "";
  let count = 0;
  let reportedTokens = 0;
  let reportedAt = 0;
  /** How many calls have begun in this reply, and the token count where the latest began (a reply can hold several calls). */
  let opens = 0;
  let announcedOpens = 0;
  let startedOpens = 0;
  let callStart = 0;
  const report = (done: boolean): void => {
    const tool = done ? undefined : toolBeingCalled(tail);
    // Inside a call, only what that call has written counts; not the calls (or the thinking) before it.
    const tokens = tool === undefined ? count : Math.max(0, count - callStart);
    sink({ request, purpose, tokens, done, ...(tool ? { tool } : {}) });
  };
  return {
    text(piece) {
      opens += (tail + piece).split(CALL_OPEN).length - tail.split(CALL_OPEN).length;
      tail = (tail + piece).slice(-600);
    },
    tokens(n) {
      count = n;
      // A new call starts its own count at the token where it began.
      if (opens > startedOpens) {
        callStart = n;
        startedOpens = opens;
      }
      // A call to a tool is reported the moment its name is known, however short the call is.
      const named = opens > announcedOpens && toolBeingCalled(tail) !== undefined;
      if (named) announcedOpens = opens;
      if (!named && n - reportedTokens < EVERY_TOKENS && now() - reportedAt < EVERY_MS)
        return;
      reportedTokens = n;
      reportedAt = now();
      report(false);
    },
    done() {
      report(true);
    },
  };
}
