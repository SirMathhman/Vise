import type { ElementHandle, Page } from "playwright-core";
import {
  type BrowserElement,
  INTERACTIVE_SELECTOR,
  kindOf,
  labelOf,
  MAX_SNAPSHOT_ELEMENTS,
  type RawElement,
  type SnapshotEntry,
} from "./elements.js";

/** A live element paired with the snapshot entry the model was shown for it. */
export interface Target {
  handle: ElementHandle;
  entry: SnapshotEntry;
}

/**
 * Collect the current interactive elements of a page in DOM order
 * (deterministic, so the model's numbers are stable across a snapshot and the
 * action that follows it). Capped at MAX_SNAPSHOT_ELEMENTS, so index `i` in the
 * result is exactly element number `i` in the snapshot the model read — a
 * number the model was never shown is never valid. All elements' properties are
 * read in one round trip.
 */
export async function collectTargets(page: Page): Promise<Target[]> {
  const handles = (await page.$$(INTERACTIVE_SELECTOR)).slice(
    0,
    MAX_SNAPSHOT_ELEMENTS
  );
  const raws = (await page.evaluate((els) => {
    return (els as unknown as BrowserElement[]).map((a) => ({
      tag: a.tagName.toLowerCase(),
      aria: a.getAttribute("aria-label") ?? "",
      text: (a.textContent ?? "").trim(),
      value: a.value,
      placeholder: a.placeholder,
      name: a.getAttribute("name") ?? "",
      id: a.id,
      href: a.href,
      type: a.type,
      draggable: a.getAttribute("draggable") === "true",
    }));
  }, handles)) as RawElement[];
  return handles.map((handle, n) => {
    const kind = kindOf(raws[n]);
    return {
      handle,
      entry: { n, kind, label: labelOf(raws[n], kind).slice(0, 60) },
    };
  });
}

/**
 * Format a page's interactive elements as the numbered list the model reads.
 * A leading line with the title and URL orients the model to the current page
 * before the element list.
 */
export async function snapshotText(page: Page): Promise<string> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const targets = await collectTargets(page);
  const lines = targets.map(
    ({ entry: e }) => `  ${e.n}) [${e.kind}] ${e.label}`
  );
  const more =
    targets.length < MAX_SNAPSHOT_ELEMENTS
      ? ""
      : `\n  (snapshot capped at ${MAX_SNAPSHOT_ELEMENTS} elements; re-snapshot after acting if you need more)`;
  return `Title: ${title || "(untitled)"}\nURL: ${url}\nInteractive elements:\n${lines.join("\n")}${more}`;
}
