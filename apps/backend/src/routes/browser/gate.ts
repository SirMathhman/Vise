import { createServer } from "node:net";
import { type Browser, chromium, type Page } from "playwright-core";
import { badRequest } from "../../errors.js";
import { type DialogWatch, watchDialogs } from "./dialogs.js";
import type { createScreencast } from "./screencast.js";

/** How long a single page action (navigate, click, fill) may take before it is a timeout. */
const ACTION_TIMEOUT_MS = 30_000;

/** The open page and the watch holding its JavaScript dialogs (see dialogs.ts). */
export interface LivePage {
  page: Page;
  dialogs: DialogWatch;
}

/** What a page action may need besides the page itself. */
export interface ActionEnv {
  /** Where a separate process can attach to this Chrome over CDP (see codeRunner.ts). */
  cdpEndpoint: string;
}

/** Ask the OS for a free localhost port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * The page gate: owns the one Chrome browser and its single page, and makes
 * every use of the page (each tool, the panel's navigate) run one at a time,
 * so panel navigation can't interleave with a model action and two first
 * calls can't both launch Chrome.
 */
export interface PageGate {
  /** Run `run` after every earlier gated call has finished. */
  serial<T>(run: () => Promise<T>): Promise<T>;
  /**
   * Launch Chrome and open the single page if they don't exist yet, attaching
   * the screencast to any page we create. Chrome runs headless because the
   * page is rendered inside Vise's viewer panel; set VISE_BROWSER_HEADFUL to
   * get a real window back when debugging the automation itself. Call inside
   * `serial`.
   */
  ensurePage(): Promise<LivePage>;
  /** The open page, or undefined before the first open / after close. */
  current(): LivePage | undefined;
  /** The open page, or a model-readable error if none is open. */
  requirePage(): LivePage;
  /**
   * Run a page action against the open page, serialized through the gate,
   * reporting a dialog the action opens (which would otherwise block it)
   * instead of hanging on it.
   */
  guarded<T>(run: (p: Page, env: ActionEnv) => Promise<T>): Promise<T | string>;
  /** Detach the screencast and close Chrome. Safe to call more than once. */
  close(): Promise<void>;
}

export function createPageGate(
  screencast: ReturnType<typeof createScreencast>
): PageGate {
  // The one browser session, at most one page. Undefined until first open.
  let browser: Browser | undefined;
  let cdpEndpoint = "";
  let live: LivePage | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  }

  /** A model-readable error when an action needs a page but none is open. */
  function requirePage(): LivePage {
    if (!live) {
      throw badRequest(
        "no browser page is open; call browser_open with a URL first"
      );
    }
    return live;
  }

  return {
    serial,

    async ensurePage() {
      if (!browser) {
        // A localhost-only debugging port, so browser_run_code's contained
        // child process can attach to this same Chrome (Playwright itself
        // talks to it over a pipe).
        const port = await freePort();
        cdpEndpoint = `http://127.0.0.1:${port}`;
        browser = await chromium.launch({
          channel: "chrome", // drive the system Chrome, no bundled download
          headless: process.env.VISE_BROWSER_HEADFUL !== "1",
          args: [`--remote-debugging-port=${port}`],
        });
      }
      if (!live) {
        const page = await browser.newPage();
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        live = { page, dialogs: watchDialogs(page) };
        await screencast.attach(page);
      }
      return live;
    },

    current: () => live,
    requirePage,

    guarded(run) {
      return serial(() => {
        const { page, dialogs } = requirePage();
        return dialogs.guard(() => run(page, { cdpEndpoint }));
      });
    },

    /**
     * Called from app close so the Chrome process (and its helper processes)
     * don't outlive the backend.
     */
    async close() {
      const b = browser;
      const l = live;
      browser = undefined;
      live = undefined;
      // A page blocked on an open dialog can't shut down, so answer it first
      // (the throw when there is none is expected).
      await l?.dialogs.answer({ action: "dismiss" }).catch(() => undefined);
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
