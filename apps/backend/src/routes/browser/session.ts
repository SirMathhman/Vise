import { badRequest } from "../../errors.js";
import { type PageActionName, pageActions } from "./actions.js";
import { createPageGate } from "./gate.js";
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
 * one page at a time (see gate.ts) — and exposes seven tools: open, snapshot,
 * dialog, and the page actions (click, type, drag, hover), plus the
 * panel-facing navigate/stream/input surface.
 *
 * The model's interface is a numbered snapshot: `browser_open` and
 * `browser_snapshot` return the page's interactive elements as a numbered
 * list, and the page actions act on elements by number.
 * Because tool calls run serially (see llm.ts), each action re-collects the
 * element list immediately before acting, so the model's number always maps
 * to a live element without storing stale handles across calls.
 */

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
  /**
   * The page-acting tools (browser_click/type/drag/hover, see actions.ts):
   * run the named action against the open page.
   */
  act(tool: PageActionName, args: Record<string, unknown>): Promise<string>;
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
  // The screencast that mirrors the page into the viewer panel. Created eagerly
  // (it is inert until a page is attached) so subscribers can connect before
  // the first navigation, exactly like opening an empty browser tab.
  const screencast = createScreencast();
  const gate = createPageGate(screencast);
  const { serial, ensurePage, guarded } = gate;

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

    /** Run a page-acting tool (click, type, drag, hover) against the open page. */
    async act(tool, args) {
      return guarded((p) => pageActions[tool](p, args));
    },

    /** Accept or dismiss the open dialog, then return a fresh snapshot. */
    async dialog(args: Record<string, unknown>): Promise<string> {
      const result = await serial(async () =>
        gate.requirePage().dialogs.answer(args)
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
      if (gate.current()?.dialogs.isOpen()) return;
      return screencast.dispatchInput(input);
    },

    /** Close the session and release the page (see PageGate.close). */
    close() {
      return gate.close();
    },
  };
}
