import { type Browser, chromium, type Page } from "playwright-core";
import { badRequest } from "../../errors.js";
import * as actions from "./actions.js";
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
 * one page at a time — and exposes five tools: open, snapshot, click, type, and drag,
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
  let page: Page | undefined;
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
  async function ensurePage(): Promise<Page> {
    if (!browser) {
      browser = await chromium.launch({
        channel: "chrome", // drive the system Chrome, no bundled download
        headless: process.env.VISE_BROWSER_HEADFUL !== "1",
      });
    }
    if (!page) {
      page = await browser.newPage();
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      await screencast.attach(page);
    }
    return page;
  }

  /** A model-readable error when an action needs a page but none is open. */
  function requirePage(): Page {
    if (!page) {
      throw badRequest(
        "no browser page is open; call browser_open with a URL first"
      );
    }
    return page;
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

      const p = await ensurePage();
      await p.goto(url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
      const snap = await snapshotText(p);
      return `Opened the page in Vise's browser tab.\n${snap}`;
    },

    /** Re-read the active page's interactive elements and return the snapshot. */
    async snapshot(): Promise<string> {
      return snapshotText(requirePage());
    },

    /** Click the interactive element with the given number from the current page. */
    async click(args: Record<string, unknown>): Promise<string> {
      return actions.click(requirePage(), args);
    },

    /** Type text into (or check/select) the element with the given number. */
    async type(args: Record<string, unknown>): Promise<string> {
      return actions.type(requirePage(), args);
    },

    /** Drag the element numbered `from` onto the element numbered `to`. */
    async drag(args: Record<string, unknown>): Promise<string> {
      return actions.drag(requirePage(), args);
    },

    /**
     * Navigate from the panel's URL bar. Unlike `open` (a tool call) this
     * returns the resolved URL rather than a model-facing snapshot, since the
     * user reads the page itself in the stream.
     */
    async navigate(url: string): Promise<string> {
      const trimmed = url.trim();
      if (!trimmed) throw badRequest("url is required");
      const p = await ensurePage();
      await p.goto(trimmed, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
      return p.url();
    },

    subscribeFrames(cb) {
      return screencast.subscribe(cb);
    },

    setViewport(width, height) {
      return screencast.setViewport(width, height);
    },

    dispatchInput(input) {
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
      page = undefined;
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
