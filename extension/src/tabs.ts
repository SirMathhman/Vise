/**
 * The tabs Vise may use. The extension, not the server, enforces this: a tab
 * is usable only if the agent opened it or the user handed it over, so a
 * confused or prompt-injected agent cannot reach the rest of the browser.
 */

const owned = new Set<number>();
const listeners = new Set<() => void>();

/** Be told when the set of usable tabs changes. */
export function onOwnedChanged(listener: () => void): void {
  listeners.add(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

export function grant(tabId: number): void {
  if (owned.has(tabId)) return;
  owned.add(tabId);
  changed();
}

export function release(tabId: number): void {
  if (owned.delete(tabId)) changed();
}

export function ownedIds(): number[] {
  return [...owned];
}

/** Refuse a tab the agent was not given. */
export function requireOwned(tabId: unknown): number {
  if (typeof tabId !== "number" || !owned.has(tabId)) {
    throw new Error(`tab ${String(tabId)} is not available to the agent`);
  }
  return tabId;
}

browser.tabs.onRemoved.addListener((tabId) => release(tabId));
// A tab Vise uses navigating or finishing a load is worth telling the server about.
browser.tabs.onUpdated.addListener(
  (tabId) => {
    if (owned.has(tabId)) changed();
  },
  { properties: ["status", "title"] },
);
