import { type Browser, chromium, type Page } from "playwright-core";
import { badRequest } from "../../errors.js";
import * as actions from "./actions.js";
import { type DialogWatch, watchDialogs } from "./dialogs.js";
import {
  type BrowserInput,
  createScreencast,
  type ScreencastFrame,
} from "./screencast.js";
import { snapshotText } from "./snapshot.js";

/**
 * The model-driven browser session. The panel's own URL tabs render the page
 * in a cross-origin `<iframe>` that Vise's own DOM cannot script, so the model
 * drives a real Chrome page (via Playwright) instead. That page runs headless
 * and is mirrored into Vise's viewer panel as a live screencast (see
 * screencast.ts), so the user watches — and can hand-drive — the very
 * page the model is acting on. This module owns that single session — at most
 * one page at a time — and exposes six tools: open, snapshot, click, type, drag, and dialog,
 * plus the panel-facing navigate/stream/input surface.
 *
 * The model's interface is a numbered snapshot: `browser_open` and
 * `browser_snapshot` return the page's interactive elements as a numbered
 * list, and `browser_click`/`browser_type`/`browser_drag` act on elements by number.
 * Because tool calls run serially (see llm.ts), each action re-collects the
 * element list immediately before acting, so the model's number always maps
 * to a live element without storing stale handles across calls.
 */

/** How long a single page action (navigate, click, fill) may take before it is a timeout. */
const ACTION_TIMEOUT_MS = 30_000;
/** How long a page load may take before it is reported as failed. */
const LOAD_TIMEOUT_MS = 45_000;

/**
 * The app-owned model-driven browser session: a single visible Chrome page,
 * lazily opened on the first `browser_open` and closed with the app. The app
 * context creates and holds it (see context.ts), so the app's long-lived
 * resources live in one place rather than in a module-level singleton.
 */
export interface BrowserSession {
  /** browser_open: launch (if needed) and navigate the page to `args.url`. */
  open(args: Record<string, unknown>): Promise<string>;
  /** browser_snapshot: re-read the page's interactive elements. */
  snapshot(): Promise<string>;
  /** browser_click: click the element at the given number. */
  click(args: Record<string, unknown>): Promise<string>;
  /** browser_type: fill/check/select the element at the given number. */
  type(args: Record<string, unknown>): Promise<string>;
  /** browser_drag: drag the `from` element and drop it onto the `to` element. */
  drag(args: Record<string, unknown>): Promise<string>;
  /** browser_dialog: accept or dismiss the JavaScript dialog the page has open. */
  dialog(args: Record<string, unknown>): Promise<string>;
  /**
   * Navigate the page from the panel's URL bar (rather than from a tool call),
   * launching the browser if this is the first use. Returns the resolved URL.
   */
  navigate(url: string): Promise<string>;
  /** Subscribe to screencast frames for the viewer panel's browser tab. */
  subscribeFrames(cb: (frame: ScreencastFrame) => void): () => void;
  /** Resize the page viewport to match the panel showing the stream. */
  setViewport(width: number, height: number): Promise<void>;
  /** Replay a user input event from the panel into the page. */
  dispatchInput(input: BrowserInput): Promise<void>;
  /** Close the session and release the page. Safe to call more than once. */
  close(): Promise<void>;
}

export function createBrowserSession(): BrowserSession {
  // The one browser session, at most one page. Undefined until first open.
  let browser: Browser | undefined;
  // The open page and the watch holding its JavaScript dialogs (see
  // dialogs.ts), which always come and go together.
  let live: { page: Page; dialogs: DialogWatch } | undefined;
  // The gate: every use of the page (each tool, the panel's navigate) runs one
  // at a time through it, so panel navigation can't interleave with a model
  // action and two first calls can't both launch Chrome.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  }
  // The screencast that mirrors `page` into the viewer panel. Created eagerly
  // (it is inert until a page is attached) so subscribers can connect before
  // the first navigation, exactly like opening an empty browser tab.
  const screencast = createScreencast();

  /**
   * Launch Chrome and open the single page if they don't exist yet, attaching
   * the screencast to any page we create. Chrome runs headless because the
   * page is rendered inside Vise's viewer panel now; set VISE_BROWSER_HEADFUL
   * to get a real window back when debugging the automation itself.
   */
  async function ensurePage(): Promise<NonNullable<typeof live>> {
    if (!browser) {
      browser = await chromium.launch({
        channel: "chrome", // drive the system Chrome, no bundled download
        headless: process.env.VISE_BROWSER_HEADFUL !== "1",
      });
    }
    if (!live) {
      const page = await browser.newPage();
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      live = { page, dialogs: watchDialogs(page) };
      await screencast.attach(page);
    }
    return live;
  }

  /** A model-readable error when an action needs a page but none is open. */
  function requirePage(): NonNullable<typeof live> {
    if (!live) {
      throw badRequest(
        "no browser page is open; call browser_open with a URL first"
      );
    }
    return live;
  }

  /**
   * Run a page action against the open page, serialized through the gate,
   * reporting a dialog the action opens (which would otherwise block it)
   * instead of hanging on it.
   */
  function guarded(run: (p: Page) => Promise<string>): Promise<string> {
    return serial(() => {
      const { page, dialogs } = requirePage();
      return dialogs.guard(() => run(page));
    });
  }

  return {
    /**
     * browser_open: launch Chrome if it isn't already, open (or reuse) the
     * single page, navigate it to `url`, and return a snapshot of the page's
     * interactive elements so the model knows what it can act on.
     */
    async open(args: Record<string, unknown>): Promise<string> {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw badRequest("url is required");

      return serial(async () => {
        const { page, dialogs } = await ensurePage();
        return dialogs.guard(async () => {
          await page.goto(url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
          const snap = await snapshotText(page);
          return `Opened the page in Vise's browser tab.\n${snap}`;
        });
      });
    },

    /** Re-read the active page's interactive elements and return the snapshot. */
    async snapshot(): Promise<string> {
      return guarded(snapshotText);
    },

    /** Click the interactive element with the given number from the current page. */
    async click(args: Record<string, unknown>): Promise<string> {
      return guarded((p) => actions.click(p, args));
    },

    /** Type text into (or check/select) the element with the given number. */
    async type(args: Record<string, unknown>): Promise<string> {
      return guarded((p) => actions.type(p, args));
    },

    /** Drag the element numbered `from` onto the element numbered `to`. */
    async drag(args: Record<string, unknown>): Promise<string> {
      return guarded((p) => actions.drag(p, args));
    },

    /** Accept or dismiss the open dialog, then return a fresh snapshot. */
    async dialog(args: Record<string, unknown>): Promise<string> {
      const result = await serial(async () =>
        requirePage().dialogs.answer(args)
      );
      return `${result}\n${await guarded(snapshotText)}`;
    },

    /**
     * Navigate from the panel's URL bar. Unlike `open` (a tool call) this
     * returns the resolved URL rather than a model-facing snapshot, since the
     * user reads the page itself in the stream.
     */
    async navigate(url: string): Promise<string> {
      const trimmed = url.trim();
      if (!trimmed) throw badRequest("url is required");
      return serial(async () => {
        const { page, dialogs } = await ensurePage();
        // A dialog blocks the page and the headless stream can't show it, so
        // refuse rather than hang; only the model can answer it.
        dialogs.assertClosed();
        await page.goto(trimmed, {
          waitUntil: "load",
          timeout: LOAD_TIMEOUT_MS,
        });
        return page.url();
      });
    },

    subscribeFrames(cb) {
      return screencast.subscribe(cb);
    },

    setViewport(width, height) {
      return screencast.setViewport(width, height);
    },

    async dispatchInput(input) {
      // Input would hang behind an open dialog; drop it instead.
      if (live?.dialogs.isOpen()) return;
      return screencast.dispatchInput(input);
    },

    /**
     * Close the browser session and release the page. Called from app close so
     * the Chrome process (and its helper processes) don't outlive the
     * backend. Safe to call when no session was ever opened, or more than once.
     */
    async close(): Promise<void> {
      const b = browser;
      browser = undefined;
      live = undefined;
      // Detach CDP before killing the browser so the session teardown doesn't
      // race the process exit and log a spurious protocol error.
      await screencast.close();
      if (b) {
        try {
          await b.close();
        } catch {
          // Already closed (e.g. the user closed the window); nothing to clean up.
        }
      }
    },
  };
}
