/**
 * The tabs Vise may use. The extension, not the server, enforces this: a tab
 * is usable only if the agent opened it or the user handed it over, so a
 * confused or prompt-injected agent cannot reach the rest of the browser.
 *
 * A limit on the number of tabs is enforced here: when the limit is reached,
 * new tabs are refused (for agent-opened tabs) or queued (for auto-granted
 * tabs from target=_blank / window.open). The limit value is set by the
 * server via a config message and stored in browser.storage.local.
 */

const owned = new Set<number>();
const listeners = new Set<() => void>();
const promotedListeners = new Set<(tab: PromotedTab) => void>();

/** A tab that was waiting in the queue and is now available. */
export interface PromotedTab {
  id: number;
  title: string;
  url: string;
}

/** A tab waiting for a slot to free up. */
interface PendingTab {
  id: number;
  title: string;
  url: string;
}

const pending: PendingTab[] = [];
const MAX_PENDING = 3;

/** The current tab limit (read live; defaults to 5 until the server sets one). */
let tabLimit = 5;

/** Set the tab limit (called when the server sends config). */
export function setTabLimit(n: number): void {
  if (Number.isInteger(n) && n >= 1) tabLimit = n;
}

/** The current tab limit. */
export function getTabLimit(): number {
  return tabLimit;
}

/** Be told when the set of usable tabs changes. */
export function onOwnedChanged(listener: () => void): void {
  listeners.add(listener);
}

/** Be told when a queued tab is promoted to owned. */
export function onPromoted(listener: (tab: PromotedTab) => void): void {
  promotedListeners.add(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

/** Try to grant a tab; returns a result object. */
export function tryGrant(tabId: number): { ok: true } | { ok: false; reason: "limit" } {
  if (owned.has(tabId)) return { ok: true };
  if (owned.size >= tabLimit) return { ok: false, reason: "limit" };
  owned.add(tabId);
  changed();
  return { ok: true };
}

/** Queue a tab that could not be granted because the limit was reached. */
export function enqueue(tabId: number, title: string, url: string): void {
  if (pending.some((t) => t.id === tabId)) return;
  pending.push({ id: tabId, title, url });
  if (pending.length > MAX_PENDING) pending.shift();
  changed();
}

/** The number of tabs waiting in the queue. */
export function pendingCount(): number {
  return pending.length;
}

export function grant(tabId: number): void {
  tryGrant(tabId);
}

export function isOwned(tabId: number): boolean {
  return owned.has(tabId);
}

export function release(tabId: number): void {
  if (!owned.delete(tabId)) return;
  // Promote a queued tab if there is one.
  if (pending.length > 0) {
    const next = pending.shift()!;
    owned.add(next.id);
    for (const listener of promotedListeners) listener(next);
  }
  changed();
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

browser.tabs.onRemoved.addListener((tabId) => {
  const idx = pending.findIndex((t) => t.id === tabId);
  if (idx !== -1) pending.splice(idx, 1);
  release(tabId);
});
// A tab Vise uses navigating or finishing a load is worth telling the server about.
browser.tabs.onUpdated.addListener(
  (tabId) => {
    if (owned.has(tabId)) changed();
  },
  { properties: ["status", "title"] },
);
// A tab that a tab Vise controls opens (a link with target=_blank, window.open: "Apply on company
// website") is part of the same task, so the agent may use it too (the user can still release it).
// If the limit is reached, the tab is queued and promoted when a slot frees up.
browser.tabs.onCreated.addListener((tab) => {
  if (
    tab.id !== undefined &&
    tab.openerTabId !== undefined &&
    owned.has(tab.openerTabId)
  ) {
    const result = tryGrant(tab.id);
    if (!result.ok) {
      enqueue(tab.id, tab.title ?? "", tab.url ?? "");
    }
  }
});
