import type { BrowserBackend } from "../browser/types.ts";

/**
 * Waiting for a page to change. Pages that update without loading (single-page
 * apps, search results appearing after a keypress) cannot be read right after
 * an action: the read would see the old content. These wait on the page's
 * visible text, read through `BrowserBackend.readText`, so they work the same
 * on every backend.
 */

const POLL_MS = 250;
/** How long the page text must stay unchanged to count as settled. */
const QUIET_MS = 600;
/** One read must not hang the wait (a blocking dialog can stall a page's script). */
const READ_TIMEOUT_MS = 2_000;

export const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 60;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The wait limit in milliseconds from a `timeout_seconds` argument. */
export function timeoutMs(value: unknown): number {
  const seconds =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(value, MAX_TIMEOUT_SECONDS)
      : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Why a wait ended without its condition: a dialog that needs an answer, or the time running out. */
function gaveUp(browser: BrowserBackend, id: number, timedOut: string): string {
  return browser.pendingDialog(id)
    ? "error: stopped waiting because a dialog opened"
    : timedOut;
}

/** The page's text now, or undefined when the read does not answer in time. */
async function readNow(
  browser: BrowserBackend,
  id: number,
): Promise<string | undefined> {
  const timeout = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), READ_TIMEOUT_MS),
  );
  return Promise.race([browser.readText(id), timeout]);
}

/** Poll until `done(text)` says so or the time runs out; returns how long it took, or undefined on timeout. */
async function poll(
  browser: BrowserBackend,
  id: number,
  limitMs: number,
  done: (text: string, elapsedMs: number) => boolean,
): Promise<number | undefined> {
  const started = Date.now();
  for (;;) {
    const text = await readNow(browser, id);
    const elapsed = Date.now() - started;
    if (text !== undefined && done(text, elapsed)) return elapsed;
    // A dialog that opened is something to answer, not something to wait out.
    if (browser.pendingDialog(id) || elapsed >= limitMs) return undefined;
    await sleep(POLL_MS);
  }
}

/** Wait until `text` (case-insensitive) is on the page. */
export async function waitForText(
  browser: BrowserBackend,
  id: number,
  text: string,
  limitMs: number,
): Promise<string> {
  const wanted = text.toLowerCase();
  const took = await poll(browser, id, limitMs, (page) =>
    page.toLowerCase().includes(wanted),
  );
  return took === undefined
    ? gaveUp(
        browser,
        id,
        `error: "${text}" did not appear within ${seconds(limitMs)}`,
      )
    : `"${text}" appeared after ${seconds(took)}`;
}

/** Wait until `text` (case-insensitive) is no longer on the page. */
export async function waitForTextGone(
  browser: BrowserBackend,
  id: number,
  text: string,
  limitMs: number,
): Promise<string> {
  const unwanted = text.toLowerCase();
  const took = await poll(
    browser,
    id,
    limitMs,
    (page) => !page.toLowerCase().includes(unwanted),
  );
  return took === undefined
    ? gaveUp(
        browser,
        id,
        `error: "${text}" was still on the page after ${seconds(limitMs)}`,
      )
    : `"${text}" was gone after ${seconds(took)}`;
}

/** Wait until the page's text has stopped changing for a moment. */
export async function waitForIdle(
  browser: BrowserBackend,
  id: number,
  limitMs: number,
): Promise<string> {
  let last: string | undefined;
  let changedAt = 0;
  const took = await poll(browser, id, limitMs, (page, elapsed) => {
    if (page !== last) {
      last = page;
      changedAt = elapsed;
    }
    return elapsed - changedAt >= QUIET_MS;
  });
  return took === undefined
    ? gaveUp(
        browser,
        id,
        `the page was still changing after ${seconds(limitMs)} (a live page may never settle); read it as it is`,
      )
    : `the page settled after ${seconds(took)}`;
}

type Handler = (args: Record<string, unknown>) => Promise<string>;

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
    browser_wait_for_text: (args) =>
      onTab(
        args,
        (id) => waitForText(browser, id, text(args), limit(args)),
        "",
      ),
    browser_wait_for_text_gone: (args) =>
      onTab(
        args,
        (id) => waitForTextGone(browser, id, text(args), limit(args)),
        "",
      ),
    browser_wait_for_idle: (args) =>
      onTab(args, (id) => waitForIdle(browser, id, limit(args)), ""),
  };
}
