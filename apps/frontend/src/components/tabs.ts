/**
 * A DOM-free store for the viewer's open-file tabs. It owns the ordered list
 * of open tabs (each a workspace-relative path plus a unique id) and which tab
 * is active, and persists that list across page reloads. It is deliberately
 * free of DOM and of `api/client.ts` — like `conversations.ts`, `profiles.ts`,
 * and `skills.ts` — so it runs under Jest in Node. Per-tab editor buffers
 * (the `FileStateStore` from `fileState.ts`) are NOT owned here: those need the
 * network `persist` callback and the DOM save-status span, both controller
 * concerns, so the controller (`fileTree.ts`) keeps one `FileStateStore` per
 * tab and consults this store for the open set and the active tab.
 */

/** localStorage keys for the persisted open-tab list and the active tab id. */
const STORAGE_TABS = "vise:viewer:tabs";
const STORAGE_ACTIVE = "vise:viewer:active";

/** A single open tab: the file's relative path and a unique id. */
export interface Tab {
  id: string;
  /** Workspace-relative path of the open file (forward-slash separated). */
  rel: string;
}

/** True when `value` is a structurally valid persisted tab. */
function isValidTab(value: unknown): value is Tab {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Tab).id === "string" &&
    typeof (value as Tab).rel === "string"
  );
}

/** Generate a unique id for a new tab. */
function newId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the timestamp id.
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist the open-tab list and the active id. Best-effort. */
function saveTabs(tabs: Tab[], activeId: string): void {
  try {
    localStorage.setItem(STORAGE_TABS, JSON.stringify(tabs));
    localStorage.setItem(STORAGE_ACTIVE, activeId);
  } catch {
    // Storage may be unavailable (private mode, quota); persistence is a
    // best-effort enhancement, so failures are ignored.
  }
}

/**
 * Restore the persisted open-tab list. Returns an empty array when nothing is
 * stored (first run) or the stored value is malformed. A tab is reopened by
 * its `rel`; the active tab's `id` is restored separately (see the store).
 */
function loadTabs(): Tab[] {
  try {
    const raw = safeGetItem(STORAGE_TABS);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTab);
  } catch {
    return [];
  }
}

function loadActiveId(): string | null {
  return safeGetItem(STORAGE_ACTIVE);
}

/**
 * A store for the viewer's open tabs: the ordered list of open files and which
 * tab is active. Opening a file that is already open activates that existing
 * tab rather than creating a duplicate; closing the active tab promotes the
 * first remaining tab, and closing the last tab leaves the store empty (the
 * viewer shows its "select a file" hint).
 */
export interface TabStore {
  /** The active tab's id, or `null` when no tab is open. */
  activeId(): string | null;
  /** The active tab, or `null` when no tab is open. */
  getActive(): Tab | null;
  /** All open tabs, in display (left-to-right) order. */
  getTabs(): Tab[];
  /**
   * Open a file: if a tab already holds `rel`, activate it (a no-op when that
   * tab is already active); otherwise create a new tab for `rel` and activate
   * it. Returns the (existing or new) tab's id.
   */
  open(rel: string): string;
  /**
   * Close the tab with this id. If it was active, the first remaining tab
   * becomes active (or none, when the last tab is closed). No-op if no tab has
   * that id.
   */
  close(id: string): void;
  /** Activate the tab with this id (no-op when no tab has that id). */
  activate(id: string): void;
  /** Persist the open-tab list and the active id. */
  persist(): void;
}

/** Build a tab store from persisted state. */
export function createTabStore(): TabStore {
  let tabs: Tab[] = loadTabs();
  let activeId: string | null = loadActiveId();

  // Pick the active tab: a stored id if it still exists, else the first
  // restored tab, else none.
  if (activeId !== null && !tabs.some((t) => t.id === activeId)) {
    activeId = tabs.length > 0 ? tabs[0].id : null;
  }

  const getActive = (): Tab | null =>
    tabs.find((t) => t.id === activeId) ?? null;

  return {
    activeId: () => activeId,
    getActive,
    getTabs: () => tabs,
    open(rel) {
      const existing = tabs.find((t) => t.rel === rel);
      if (existing) {
        activeId = existing.id;
        return existing.id;
      }
      const id = newId();
      tabs = [...tabs, { id, rel }];
      activeId = id;
      return id;
    },
    close(id) {
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1) return;
      tabs = tabs.filter((t) => t.id !== id);
      if (activeId === id) {
        activeId = tabs.length > 0 ? tabs[0].id : null;
      }
    },
    activate(id) {
      if (tabs.some((t) => t.id === id)) activeId = id;
    },
    persist() {
      saveTabs(tabs, activeId ?? "");
    },
  };
}
