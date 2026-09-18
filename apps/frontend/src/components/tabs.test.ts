import { createTabStore } from "./tabs.js";

/**
 * A minimal in-memory localStorage polyfill for the Node test environment
 * (Jest's `node` environment provides no `localStorage`). This makes the
 * persistence assertions below actually round-trip, the same way the store
 * round-trips in the browser. It is installed before any store is created.
 */
function installLocalStorage(): void {
  if (
    typeof (globalThis as Record<string, unknown>).localStorage === "undefined"
  ) {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };
  }
}
installLocalStorage();

describe("TabStore: opening and activation", () => {
  it("opens a new tab for an unseen file and activates it", () => {
    const store = createTabStore();
    const id = store.open("a.txt");
    expect(store.activeId()).toBe(id);
    expect(store.getTabs()).toHaveLength(1);
    expect(store.getTabs()[0].rel).toBe("a.txt");
  });

  it("re-activates an existing tab for the same file instead of duplicating", () => {
    const store = createTabStore();
    const first = store.open("a.txt");
    store.open("b.txt");
    const second = store.open("a.txt");
    expect(second).toBe(first);
    // Re-opening the existing tab must not grow the list.
    expect(store.getTabs()).toHaveLength(2);
    // And it becomes active again.
    expect(store.activeId()).toBe(first);
  });

  it("opens tabs in left-to-right order, activating each new one", () => {
    const store = createTabStore();
    const a = store.open("a.txt");
    const b = store.open("b.txt");
    const c = store.open("c.txt");
    expect(store.getTabs().map((t) => t.id)).toEqual([a, b, c]);
    expect(store.activeId()).toBe(c);
  });
});

describe("TabStore: closing", () => {
  it("promotes the first remaining tab when the active one is closed", () => {
    const store = createTabStore();
    const a = store.open("a.txt");
    const b = store.open("b.txt");
    store.close(b); // active
    expect(store.activeId()).toBe(a);
    expect(store.getTabs()).toHaveLength(1);
  });

  it("activates the first remaining tab when a non-active one is closed", () => {
    const store = createTabStore();
    store.open("a.txt");
    const b = store.open("b.txt");
    const c = store.open("c.txt");
    // c is active; close b (non-active). Active stays c.
    store.close(b);
    expect(store.activeId()).toBe(c);
    expect(store.getTabs()).toHaveLength(2);
  });

  it("goes to no active tab when the last tab is closed", () => {
    const store = createTabStore();
    const a = store.open("a.txt");
    store.close(a);
    expect(store.activeId()).toBeNull();
    expect(store.getTabs()).toHaveLength(0);
  });

  it("is a no-op when closing an unknown id", () => {
    const store = createTabStore();
    const a = store.open("a.txt");
    store.close("not-a-real-tab");
    expect(store.activeId()).toBe(a);
    expect(store.getTabs()).toHaveLength(1);
  });
});

describe("TabStore: explicit activation", () => {
  it("activates an existing tab by id", () => {
    const store = createTabStore();
    const a = store.open("a.txt");
    store.open("b.txt");
    store.activate(a);
    expect(store.activeId()).toBe(a);
  });

  it("is a no-op when activating an unknown id", () => {
    const store = createTabStore();
    const a = store.open("a.txt");
    store.activate("nope");
    expect(store.activeId()).toBe(a);
  });
});

describe("TabStore: persistence across reloads", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // No localStorage in this environment; the store just behaves like a
      // fresh one.
    }
  });

  it("restores the open set and the active tab from localStorage", () => {
    const first = createTabStore();
    const a = first.open("a.txt");
    first.open("b.txt");
    first.activate(a);
    first.persist();

    // A fresh store in the same storage must see the same open set and the
    // active tab chosen by the user (a).
    const second = createTabStore();
    expect(second.getTabs().map((t) => t.rel)).toEqual(["a.txt", "b.txt"]);
    expect(second.activeId()).toBe(a);
  });

  it("falls back to the first restored tab when the active id is stale", () => {
    const first = createTabStore();
    const a = first.open("a.txt");
    const b = first.open("b.txt");
    first.activate(b);
    first.persist();

    // Simulate the active tab being dropped: rewrite the stored open set to
    // only contain a, but keep the stored active id as b (no longer present).
    const raw = localStorage.getItem("vise:viewer:tabs");
    expect(raw).not.toBeNull();
    const tabs = JSON.parse(raw as string) as unknown[];
    const onlyA = tabs.filter((t) => (t as { id: string }).id === a);
    localStorage.setItem("vise:viewer:tabs", JSON.stringify(onlyA));
    // Stored active is still b.
    localStorage.setItem("vise:viewer:active", b);

    const second = createTabStore();
    expect(second.activeId()).toBe(a);
  });

  it("starts empty when nothing is persisted (first run)", () => {
    const store = createTabStore();
    expect(store.getTabs()).toHaveLength(0);
    expect(store.activeId()).toBeNull();
  });
});
