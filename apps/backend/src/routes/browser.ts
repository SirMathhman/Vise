import {
  type Browser,
  chromium,
  type ElementHandle,
  type Page,
} from "playwright-core";
import { badRequest } from "../errors.js";
import {
  type BrowserInput,
  createScreencast,
  type ScreencastFrame,
} from "./browserScreencast.js";

/**
 * The model-driven browser session. The panel's own URL tabs render the page
 * in a cross-origin `<iframe>` that Vise's own DOM cannot script, so the model
 * drives a real Chrome page (via Playwright) instead. That page runs headless
 * and is mirrored into Vise's viewer panel as a live screencast (see
 * browserScreencast.ts), so the user watches — and can hand-drive — the very
 * page the model is acting on. This module owns that single session — at most
 * one page at a time — and exposes four tools: open, snapshot, click, and type,
 * plus the panel-facing navigate/stream/input surface.
 *
 * The model's interface is a numbered snapshot: `browser_open` and
 * `browser_snapshot` return the page's interactive elements as a numbered
 * list, and `browser_click`/`browser_type` act on an element by its number.
 * Because tool calls run serially (see llm.ts), each action re-collects the
 * element list immediately before acting, so the model's number always maps
 * to a live element without storing stale handles across calls.
 */

/** How long a single page action (navigate, click, fill) may take before it is a timeout. */
const ACTION_TIMEOUT_MS = 30_000;
/** How long a page load may take before it is reported as failed. */
const LOAD_TIMEOUT_MS = 45_000;
/** The maximum number of interactive elements a snapshot lists (output bound). */
const MAX_SNAPSHOT_ELEMENTS = 100;

/**
 * The CSS selector for the interactive elements a snapshot lists. Restricted
 * to elements the model can meaningfully click or type into: buttons, links,
 * text inputs, textareas, selects, ARIA button/link roles, `<summary>`
 * toggles, and contenteditable fields. Hidden inputs are excluded.
 */
const INTERACTIVE_SELECTOR =
  "button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=link], [contenteditable=true], summary";

/** The model-facing kind of an interactive element (drives label + action). */
type ElementKind =
  | "button"
  | "link"
  | "text-field"
  | "text-area"
  | "select"
  | "checkbox"
  | "radio"
  | "summary";

/** The raw properties read from a live element, used to build its label/kind. */
interface RawElement {
  tag: string;
  aria: string;
  text: string;
  value: string;
  placeholder: string;
  name: string;
  id: string;
  href: string;
  type: string;
}

/**
 * The shape of a live browser element as read inside the page context. Named
 * separately from RawElement because the backend has no DOM lib (no global
 * HTMLElement/HTMLInputElement), so the element is cast to this structural
 * type instead of a DOM type.
 */
interface BrowserElement {
  tagName: string;
  getAttribute(name: string): string | null;
  textContent: string | null;
  value: string;
  placeholder: string;
  name: string;
  id: string;
  href: string;
  type: string;
}

/** A single snapshot entry: the model-facing number, kind, and label. */
interface SnapshotEntry {
  n: number;
  kind: ElementKind;
  label: string;
}

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

/**
 * Classify an element by its tag/role/type into the model-facing kind.
 */
function kindOf(raw: RawElement): ElementKind {
  switch (raw.tag) {
    case "button":
      return "button";
    case "a":
      return "link";
    case "summary":
      return "summary";
    case "textarea":
      return "text-area";
    case "select":
      return "select";
    case "input":
      if (raw.type === "checkbox") return "checkbox";
      if (raw.type === "radio") return "radio";
      return "text-field";
    default:
      return "text-field";
  }
}

/**
 * Build the short model-facing label for an element: the most human-meaningful
 * text available (aria-label, visible text, placeholder, name, id, href),
 * truncated so a chatty page can't bloat the snapshot.
 */
function labelOf(raw: RawElement, kind: ElementKind): string {
  const fallback = `${kind} (no label)`;
  switch (kind) {
    case "button":
      return raw.aria || raw.text || raw.value || "button";
    case "link":
      return raw.aria || raw.text || raw.href || "link";
    case "text-field":
      return (
        raw.aria ||
        raw.placeholder ||
        (raw.name ? `input[name="${raw.name}"]` : "") ||
        (raw.id ? `#${raw.id}` : "") ||
        "text field"
      );
    case "text-area":
      return raw.aria || (raw.id ? `#${raw.id}` : "") || "text area";
    case "select":
      return raw.aria || (raw.id ? `#${raw.id}` : "") || "select";
    case "checkbox":
    case "radio":
      return (
        raw.aria ||
        raw.text ||
        (raw.name ? `input[name="${raw.name}"]` : "") ||
        kind
      );
    case "summary":
      return raw.aria || raw.text || "summary";
    default:
      return fallback;
  }
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

  /**
   * Collect the current interactive elements of the active page in DOM order
   * (deterministic, so the model's numbers are stable across a snapshot and
   * the action that follows it). Returns the handles (for acting) and the
   * model-facing entries (for the snapshot text).
   */
  async function collectElements(): Promise<{
    handles: ElementHandle[];
    entries: SnapshotEntry[];
  }> {
    const p = requirePage();
    const handles = await p.$$(INTERACTIVE_SELECTOR);
    const entries: SnapshotEntry[] = [];
    for (let i = 0; i < handles.length && i < MAX_SNAPSHOT_ELEMENTS; i++) {
      const raw = (await handles[i].evaluate((el) => {
        const a = el as BrowserElement;
        return {
          tag: a.tagName.toLowerCase(),
          aria: a.getAttribute("aria-label") ?? "",
          text: (a.textContent ?? "").trim(),
          value: a.value,
          placeholder: a.placeholder,
          name: a.getAttribute("name") ?? "",
          id: a.id,
          href: a.href,
          type: a.type,
        };
      })) as RawElement;
      const kind = kindOf(raw);
      const label = labelOf(raw, kind).slice(0, 60);
      entries.push({ n: i, kind, label });
    }
    return { handles, entries };
  }

  /**
   * Format a page's interactive elements as the numbered list the model
   * reads. A leading line with the title and URL orients the model to the
   * current page before the element list.
   */
  async function snapshotText(): Promise<string> {
    const p = requirePage();
    const url = p.url();
    const title = await p.title().catch(() => "");
    const { entries } = await collectElements();
    const lines = entries.map((e) => `  ${e.n}) [${e.kind}] ${e.label}`);
    const more =
      entries.length < MAX_SNAPSHOT_ELEMENTS
        ? ""
        : `\n  (snapshot capped at ${MAX_SNAPSHOT_ELEMENTS} elements; re-snapshot after acting if you need more)`;
    return `Title: ${title || "(untitled)"}\nURL: ${url}\nInteractive elements:\n${lines.join("\n")}${more}`;
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
      const snap = await snapshotText();
      return `Opened the page in Vise's browser tab.\n${snap}`;
    },

    /** Re-read the active page's interactive elements and return the snapshot. */
    async snapshot(): Promise<string> {
      requirePage();
      return snapshotText();
    },

    /** Click the interactive element with the given number from the current page. */
    async click(args: Record<string, unknown>): Promise<string> {
      requirePage();
      const n = typeof args.n === "number" ? Math.trunc(args.n) : NaN;
      if (!Number.isFinite(n))
        throw badRequest("n is required (an element number)");
      const { handles, entries } = await collectElements();
      if (n < 0 || n >= handles.length) {
        throw badRequest(
          `no element ${n}; the page has ${handles.length} interactive elements (0..${handles.length - 1})`
        );
      }
      const label = entries[n]?.label ?? "element";
      await handles[n].click();
      // A click can navigate or mutate the DOM, so hand back a fresh snapshot:
      // the model's next action must target the current element numbers.
      const snap = await snapshotText();
      return `Clicked [${entries[n]?.kind}] "${label}".\n${snap}`;
    },

    /** Type text into (or check/select) the element with the given number. */
    async type(args: Record<string, unknown>): Promise<string> {
      requirePage();
      const n = typeof args.n === "number" ? Math.trunc(args.n) : NaN;
      if (!Number.isFinite(n))
        throw badRequest("n is required (an element number)");
      const text = typeof args.text === "string" ? args.text : "";
      const { handles, entries } = await collectElements();
      if (n < 0 || n >= handles.length) {
        throw badRequest(
          `no element ${n}; the page has ${handles.length} interactive elements (0..${handles.length - 1})`
        );
      }
      const kind = entries[n]?.kind;
      const label = entries[n]?.label ?? "element";
      if (kind === "checkbox" || kind === "radio") {
        await handles[n].check();
      } else if (kind === "select") {
        // Match an option by visible label first, then by value.
        try {
          await handles[n].selectOption({ label: text });
        } catch {
          await handles[n].selectOption({ value: text });
        }
      } else if (
        kind === "text-field" ||
        kind === "text-area" ||
        kind === "summary"
      ) {
        await handles[n].fill(text);
      } else {
        throw badRequest(
          `element ${n} is a [${kind}] and cannot be typed into; use browser_click`
        );
      }
      const snap = await snapshotText();
      return `Typed "${text}" into [${kind}] "${label}".\n${snap}`;
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
