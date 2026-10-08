import { config } from "../../config.ts";
import { textProbe, type PageProbe } from "../../browser/probe.ts";
import type { BrowserBackend } from "../../browser/types.ts";

/**
 * Waiting for a page to change. Pages that update without loading (single-page
 * apps, search results appearing after a keypress) cannot be read right after
 * an action: the read would see the old content. These wait by polling a cheap
 * probe of the page (`BrowserBackend.pageProbe`, computed inside the page, or
 * the page text when a backend has no probe), so they work the same on every
 * backend and a large page costs a few bytes a poll, not its whole text.
 */

/** How long the page must stay unchanged to count as settled. */
/** A page that has not changed at all is only called settled after this long: an update may still be coming. */
/** One probe must not hang the wait (a blocking dialog can stall a page's script). */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The wait limit in milliseconds from a `timeout_seconds` argument. */
export function timeoutMs(value: unknown): number {
  const seconds =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(value, config.waitMaxSeconds)
      : config.waitDefaultSeconds;
  return seconds * 1000;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** `promise`, or undefined when it does not settle within `ms` (the timer is always cleared). */
async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  promise.catch(() => undefined); // a read that loses the race must not become an unhandled rejection
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A look at the page now, or undefined when it does not answer in time. */
function look(
  browser: BrowserBackend,
  id: number,
  needle?: string,
): Promise<PageProbe | undefined> {
  const probe = browser.pageProbe
    ? browser.pageProbe(id, needle)
    : browser.readText(id).then((text) => textProbe(text, needle));
  return within(probe, config.waitProbeTimeoutMs);
}

type Outcome = { how: "done" | "timeout" | "stopped"; took: number };

/** Poll until `done` says so, the time runs out, a dialog opens, or the turn is interrupted. */
async function poll(
  browser: BrowserBackend,
  id: number,
  limitMs: number,
  signal: AbortSignal | undefined,
  needle: string | undefined,
  done: (probe: PageProbe, elapsedMs: number) => boolean,
): Promise<Outcome> {
  const started = Date.now();
  for (;;) {
    const probe = await look(browser, id, needle);
    const took = Date.now() - started;
    if (signal?.aborted) return { how: "stopped", took };
    if (probe !== undefined && done(probe, took)) return { how: "done", took };
    // A dialog that opened is something to answer, not something to wait out.
    if (browser.pendingDialog(id)) return { how: "stopped", took };
    if (took >= limitMs) return { how: "timeout", took };
    await sleep(config.waitPollMs);
  }
}

/** The message when a wait ended without its condition: interrupted or a dialog, or the time running out. */
function gaveUp(
  browser: BrowserBackend,
  id: number,
  outcome: Outcome,
  timedOut: string,
): string {
  if (outcome.how === "timeout") return timedOut;
  return browser.pendingDialog(id)
    ? "error: stopped waiting because a dialog opened"
    : "error: stopped waiting because the turn was interrupted";
}

/** Wait until `text` (case- and whitespace-insensitive) is on the page. */
export async function waitForText(
  browser: BrowserBackend,
  id: number,
  text: string,
  limitMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const outcome = await poll(
    browser,
    id,
    limitMs,
    signal,
    text,
    (probe) => probe.contains,
  );
  return outcome.how === "done"
    ? `"${text}" appeared after ${seconds(outcome.took)}`
    : gaveUp(
        browser,
        id,
        outcome,
        `error: "${text}" did not appear within ${seconds(limitMs)}`,
      );
}

/** Wait until `text` is no longer on the page. */
export async function waitForTextGone(
  browser: BrowserBackend,
  id: number,
  text: string,
  limitMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const outcome = await poll(
    browser,
    id,
    limitMs,
    signal,
    text,
    (probe) => !probe.contains,
  );
  return outcome.how === "done"
    ? `"${text}" was gone after ${seconds(outcome.took)}`
    : gaveUp(
        browser,
        id,
        outcome,
        `error: "${text}" was still on the page after ${seconds(limitMs)}`,
      );
}

/**
 * Wait until the page has stopped changing for a moment. A page that changes is
 * settled `QUIET_MS` after its last change; one that never changes is only
 * called settled after `MIN_IDLE_MS`, since the update the caller is waiting for
 * may simply not have started yet.
 */
export async function waitForIdle(
  browser: BrowserBackend,
  id: number,
  limitMs: number,
  signal?: AbortSignal,
): Promise<string> {
  let last: string | undefined;
  let changedAt = 0;
  let changed = false;
  const outcome = await poll(
    browser,
    id,
    limitMs,
    signal,
    undefined,
    (probe, elapsed) => {
      if (probe.fingerprint !== last) {
        changed ||= last !== undefined;
        last = probe.fingerprint;
        changedAt = elapsed;
      }
      return (
        elapsed - changedAt >= config.waitQuietMs &&
        (changed || elapsed >= config.waitMinIdleMs)
      );
    },
  );
  return outcome.how === "done"
    ? `the page settled after ${seconds(outcome.took)}`
    : gaveUp(
        browser,
        id,
        outcome,
        `the page was still changing after ${seconds(limitMs)} (a live page may never settle); read it as it is`,
      );
}

type Handler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<string>;

/** Runs `action` on the tab named in `args` (validating it) and reports its result. */
type OnTab = (
  args: Record<string, unknown>,
  action: (id: number) => Promise<string | void>,
  done: string,
) => Promise<string>;

/** The three wait tools, bound to a backend; `onTab` validates the tab and `text` reads the required text argument. */
export function waitHandlers(
  browser: BrowserBackend,
  onTab: OnTab,
  text: (args: Record<string, unknown>) => string,
): Record<string, Handler> {
  const limit = (args: Record<string, unknown>): number =>
    timeoutMs(args["timeout_seconds"]);
  return {
    browser_wait_for_text: (args, signal) =>
      onTab(
        args,
        (id) => waitForText(browser, id, text(args), limit(args), signal),
        "",
      ),
    browser_wait_for_text_gone: (args, signal) =>
      onTab(
        args,
        (id) => waitForTextGone(browser, id, text(args), limit(args), signal),
        "",
      ),
    browser_wait_for_idle: (args, signal) =>
      onTab(args, (id) => waitForIdle(browser, id, limit(args), signal), ""),
  };
}
