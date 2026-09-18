import { createSkillStore } from "./skills.js";

/** A minimal in-memory localStorage backed by a plain Map. */
class MemoryLocalStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

describe("skill store", () => {
  let storage: MemoryLocalStorage;

  beforeEach(() => {
    storage = new MemoryLocalStorage();
    (globalThis as Record<string, unknown>).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("starts with no skills on first run", () => {
    const store = createSkillStore();
    expect(store.getSkills()).toHaveLength(0);
  });

  it("createSkill adds a new skill with empty summary and content", () => {
    const store = createSkillStore();
    const s = store.createSkill("code-review");
    expect(s).toBeDefined();
    expect(store.getSkills()).toHaveLength(1);
    expect(store.getSkill("code-review")).toEqual(s);
    expect(s?.name).toBe("code-review");
    expect(s?.summary).toBe("");
    expect(s?.content).toBe("");
  });

  it("createSkill refuses to create a second skill with the same name", () => {
    const store = createSkillStore();
    expect(store.createSkill("code-review")).toBeDefined();
    expect(store.createSkill("code-review")).toBeUndefined();
    expect(store.getSkills()).toHaveLength(1);
  });

  it("updateSkill merges a patch into the skill with that name", () => {
    const store = createSkillStore();
    store.createSkill("code-review");
    store.updateSkill("code-review", {
      summary: "Review code for bugs.",
      content: "Check the diff line by line.",
    });

    const updated = store.getSkill("code-review");
    expect(updated?.summary).toBe("Review code for bugs.");
    expect(updated?.content).toBe("Check the diff line by line.");
    // The name is fixed after creation.
    expect(updated?.name).toBe("code-review");
  });

  it("updateSkill is a no-op for an unknown name", () => {
    const store = createSkillStore();
    store.updateSkill("nope", { summary: "x" });
    expect(store.getSkills()).toHaveLength(0);
  });

  it("deleteSkill removes a skill and returns true", () => {
    const store = createSkillStore();
    store.createSkill("code-review");
    expect(store.deleteSkill("code-review")).toBe(true);
    expect(store.getSkills()).toHaveLength(0);
    expect(store.getSkill("code-review")).toBeUndefined();
  });

  it("deleteSkill refuses an unknown name", () => {
    const store = createSkillStore();
    expect(store.deleteSkill("nope")).toBe(false);
  });

  it("persist() round-trips skills across a new store", () => {
    const first = createSkillStore();
    first.createSkill("code-review");
    first.updateSkill("code-review", {
      summary: "Review code.",
      content: "Check the diff.",
    });
    first.persist();

    // A fresh store (simulating a page reload) must load the skill verbatim.
    const reloaded = createSkillStore();
    expect(reloaded.getSkills()).toHaveLength(1);
    expect(reloaded.getSkill("code-review")).toEqual({
      name: "code-review",
      summary: "Review code.",
      content: "Check the diff.",
    });
  });

  it("ignores a malformed persisted skill on load", () => {
    storage.setItem(
      "vise:llm:skills",
      JSON.stringify([{ name: "ok", summary: "s", content: "c" }, 42])
    );
    const store = createSkillStore();
    expect(store.getSkills()).toHaveLength(1);
    expect(store.getSkill("ok")).toEqual({
      name: "ok",
      summary: "s",
      content: "c",
    });
  });
});
