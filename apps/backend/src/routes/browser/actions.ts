import type { ElementHandle, Page } from "playwright-core";
import { badRequest } from "../../errors.js";
import type { LlmToolResult } from "../llmToolTypes.js";
import { runSnippet } from "./codeRunner.js";
import type { ActionEnv } from "./gate.js";
import { snapshotText } from "./snapshot.js";
import { resolveTargets } from "./targets.js";

/** How long a page load (navigate, back, forward, reload) may take before it is reported as failed. */
export const LOAD_TIMEOUT_MS = 45_000;
/** JPEG quality of a screenshot sent to the model (0-100). */
const SCREENSHOT_QUALITY = 70;
/** The maximum characters of page text or code result returned to the model. */
const MAX_TEXT_CHARS = 20_000;
/** Intermediate mouse moves in a drag; drag libraries need more than one move event to start. */
const DRAG_MOVE_STEPS = 10;

/**
 * The result every page action returns: what it did, then a fresh snapshot.
 * A page action can navigate or mutate the DOM, so the model's next action
 * must target the current element numbers.
 */
async function withSnapshot(page: Page, message: string): Promise<string> {
  return `${message}\n${await snapshotText(page)}`;
}

/** browser_click: click the element with the given number. */
async function click(
  page: Page,
  args: Record<string, unknown>
): Promise<string> {
  const [{ handle, entry }] = await resolveTargets(page, args, ["n"]);
  await handle.click();
  return withSnapshot(page, `Clicked [${entry.kind}] "${entry.label}".`);
}

/** browser_hover: move the mouse over the element with the given number. */
async function hover(
  page: Page,
  args: Record<string, unknown>
): Promise<string> {
  const [{ handle, entry }] = await resolveTargets(page, args, ["n"]);
  await handle.hover();
  return withSnapshot(page, `Hovered over [${entry.kind}] "${entry.label}".`);
}

/**
 * browser_type: type into (or check/select) the element with the given number
 * and/or press a key. With a `key` (a Playwright key name such as "Enter" or
 * "Control+A") and no element number, the key goes to whatever has focus.
 */
async function type(
  page: Page,
  args: Record<string, unknown>
): Promise<string> {
  const key = typeof args.key === "string" ? args.key : "";
  if (key && args.n === undefined && args.text === undefined) {
    await page.keyboard.press(key);
    return withSnapshot(page, `Pressed ${key}.`);
  }
  const text = typeof args.text === "string" ? args.text : "";
  const [{ handle, entry }] = await resolveTargets(page, args, ["n"]);
  const { kind, label, n } = entry;
  // With a key and no text, the key alone is the action (it may target an
  // element that can't be typed into, like a button).
  const typing = !key || args.text !== undefined;
  if (typing) {
    if (kind === "checkbox" || kind === "radio") {
      await handle.check();
    } else if (kind === "select") {
      // Match an option by visible label first, then by value.
      try {
        await handle.selectOption({ label: text });
      } catch {
        await handle.selectOption({ value: text });
      }
    } else if (
      kind === "text-field" ||
      kind === "text-area" ||
      kind === "summary"
    ) {
      await handle.fill(text);
    } else {
      throw badRequest(
        `element ${n} is a [${kind}] and cannot be typed into; use browser_click`
      );
    }
  }
  if (key) await handle.press(key);
  const on = `[${kind}] "${label}"`;
  if (!key) return withSnapshot(page, `Typed "${text}" into ${on}.`);
  return withSnapshot(
    page,
    typing
      ? `Typed "${text}" into ${on}, then pressed ${key}.`
      : `Pressed ${key} on ${on}.`
  );
}

/**
 * Scroll an element into view and return the viewport coordinates of its
 * center, or a model-readable error if it has no visible box.
 */
async function centerOf(
  handle: ElementHandle,
  n: number
): Promise<{ x: number; y: number }> {
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box)
    throw badRequest(`element ${n} is not visible and cannot be dragged`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * browser_drag: drag the element numbered `from` onto the element numbered
 * `to`, using real mouse press/move/release events so HTML5 drag-and-drop and
 * drag libraries respond as they would to a user.
 */
async function drag(
  page: Page,
  args: Record<string, unknown>
): Promise<string> {
  const [source, target] = await resolveTargets(page, args, ["from", "to"]);
  const start = await centerOf(source.handle, source.entry.n);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    // Measure the target after picking up: scrolling the source into view may
    // have moved it.
    const end = await centerOf(target.handle, target.entry.n);
    await page.mouse.move(end.x, end.y, { steps: DRAG_MOVE_STEPS });
  } finally {
    // Never leave the button held down in the shared page if the move failed.
    await page.mouse.up();
  }
  const s = source.entry;
  const t = target.entry;
  return withSnapshot(
    page,
    `Dragged [${s.kind}] "${s.label}" onto [${t.kind}] "${t.label}".`
  );
}

/**
 * The page-acting browser tools, keyed by tool name. Each takes the open page
 * and the model's arguments and returns a result ending in a fresh snapshot.
 * Adding a tool of this shape means adding an entry here (plus its name in
 * `@vise/shared` and its schema in the frontend); the session and the tool
 * registry derive from this record.
 */
export const pageActions = {
  browser_click: click,
  browser_type: type,
  browser_drag: drag,
  browser_hover: hover,
  browser_navigate: navigate,
  browser_read: read,
  browser_run_code: runCode,
} satisfies Record<
  string,
  (page: Page, args: Record<string, unknown>, env: ActionEnv) => Promise<string>
>;

/** The name of a page-acting browser tool. */
export type PageActionName = keyof typeof pageActions;

/** browser_navigate: go back, go forward, or reload the current page. */
async function navigate(
  page: Page,
  args: Record<string, unknown>
): Promise<string> {
  const action = args.action;
  const opts = { waitUntil: "load", timeout: LOAD_TIMEOUT_MS } as const;
  if (action === "reload") {
    await page.reload(opts);
    return withSnapshot(page, "Reloaded the page.");
  }
  if (action !== "back" && action !== "forward") {
    throw badRequest('action must be "back", "forward", or "reload"');
  }
  const before = page.url();
  // Resolves to null when there is no such history entry (or a same-document
  // move), so whether we moved is judged by the URL changing.
  await (action === "back" ? page.goBack(opts) : page.goForward(opts));
  const moved = page.url() !== before;
  return withSnapshot(
    page,
    moved
      ? `Went ${action}.`
      : `There is no ${action === "back" ? "previous" : "next"} page in the history.`
  );
}

/** Cut `text` to the model's output bound, saying so when it was cut. */
function capText(text: string): string {
  return text.length <= MAX_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_TEXT_CHARS)}\n(truncated at ${MAX_TEXT_CHARS} characters)`;
}

/** browser_read: the visible text content of the page. */
async function read(
  page: Page,
  _args: Record<string, unknown>
): Promise<string> {
  // A string expression, because the backend has no DOM lib to type a function.
  const text = String(await page.evaluate("document.body.innerText"));
  const title = await page.title().catch(() => "");
  return `Title: ${title || "(untitled)"}\nURL: ${page.url()}\nPage text:\n${capText(text.trim())}`;
}

/**
 * browser_run_code: run a JavaScript snippet as an async function body with
 * the Playwright `page` in scope. It runs in a contained child process (see
 * codeRunner.ts), not in the backend. Its return value (JSON) is reported,
 * then a fresh snapshot, since the code may have changed the page.
 */
async function runCode(
  page: Page,
  args: Record<string, unknown>,
  env: ActionEnv
): Promise<string> {
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim()) throw badRequest("code is required");
  const shown = await runSnippet(env.cdpEndpoint, code);
  return withSnapshot(page, `Code returned: ${capText(shown)}`);
}

/**
 * browser_screenshot: capture the page as a JPEG (much smaller than a PNG,
 * which matters because it is sent to the model and held in memory) and return
 * it as an image. `full_page` captures the whole scrollable page instead of
 * just the viewport.
 */
export async function screenshot(
  page: Page,
  args: Record<string, unknown>
): Promise<LlmToolResult> {
  const fullPage = args.full_page === true;
  const bytes = await page.screenshot({
    type: "jpeg",
    quality: SCREENSHOT_QUALITY,
    fullPage,
  });
  const title = await page.title().catch(() => "");
  return {
    text: `Took a screenshot of ${fullPage ? "the full page" : "the viewport"}: "${title || "(untitled)"}" at ${page.url()}. It is attached as an image.`,
    images: [`data:image/jpeg;base64,${bytes.toString("base64")}`],
  };
}
