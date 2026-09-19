import {
  type Browser,
  chromium,
  type ElementHandle,
  type Page,
} from "playwright-core";
import { badRequest } from "../errors.js";
import type { LlmToolHandler } from "./llmToolTypes.js";

/**
 * The model-driven browser session. The panel's own URL tabs render the page
 * in a cross-origin `<iframe>` that Vise's own DOM cannot script, so the model
 * drives a separate, visible Chrome window (via Playwright) that mirrors the
 * page it wants to act on. This module owns that single session — at most one
 * page at a time — and exposes four tools: open, snapshot, click, and type.
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

/** The one browser session, at most one page. Undefined until first open. */
let browser: Browser | undefined;
let page: Page | undefined;

/** True when a browser session has been opened at least once. */
function hasPage(): boolean {
  return page !== undefined;
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

/**
 * Collect the current interactive elements of the active page in DOM order
 * (deterministic, so the model's numbers are stable across a snapshot and the
 * action that follows it). Returns the handles (for acting) and the
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
 * Format a page's interactive elements as the numbered list the model reads.
 * A leading line with the title and URL orients the model to the current
 * page before the element list.
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

/** Open (or navigate the existing) browser page to `url` and return a snapshot. */
export const browserOpen: LlmToolHandler = async (args) => {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) throw badRequest("url is required");

  if (!browser) {
    browser = await chromium.launch({
      channel: "chrome", // drive the system Chrome, no bundled download
      headless: false, // a visible window the user can watch
    });
  }
  if (!page) page = await browser.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await page.goto(url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
  const snap = await snapshotText();
  return `Opened the page in the browser window.\n${snap}`;
};

/** Re-read the active page's interactive elements and return the snapshot. */
export const browserSnapshot: LlmToolHandler = async () => {
  requirePage();
  return snapshotText();
};

/** Click the interactive element with the given number from the current page. */
export const browserClick: LlmToolHandler = async (args) => {
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
};

/** Type text into the interactive element with the given number. */
export const browserType: LlmToolHandler = async (args) => {
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
};

/**
 * Close the browser session and release the page. Called from app close so the
 * Chrome process (and its helper processes) don't outlive the backend. Safe
 * to call when no session was ever opened, or more than once.
 */
export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = undefined;
  page = undefined;
  if (b) {
    try {
      await b.close();
    } catch {
      // Already closed (e.g. the user closed the window); nothing to clean up.
    }
  }
}

export function isBrowserOpen(): boolean {
  return hasPage();
}
