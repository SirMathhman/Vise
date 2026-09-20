import type { ElementHandle, Page } from "playwright-core";
import { badRequest } from "../../errors.js";
import { snapshotText } from "./snapshot.js";
import { resolveTargets } from "./targets.js";

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

/** browser_type: type into (or check/select) the element with the given number. */
async function type(
  page: Page,
  args: Record<string, unknown>
): Promise<string> {
  const text = typeof args.text === "string" ? args.text : "";
  const [{ handle, entry }] = await resolveTargets(page, args, ["n"]);
  const { kind, label, n } = entry;
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
  return withSnapshot(page, `Typed "${text}" into [${kind}] "${label}".`);
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
} satisfies Record<
  string,
  (page: Page, args: Record<string, unknown>) => Promise<string>
>;

/** The name of a page-acting browser tool. */
export type PageActionName = keyof typeof pageActions;
