import { LLM_TOOL_NAMES } from "@vise/shared";
import {
  createProfileStore,
  DEFAULT_PROFILE_ID,
  DEFAULT_SYSTEM_PROMPT,
} from "./profiles.js";

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

describe("profile store", () => {
  let storage: MemoryLocalStorage;

  beforeEach(() => {
    storage = new MemoryLocalStorage();
    (globalThis as Record<string, unknown>).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("seeds the default profile with every tool allowed and no hooks", () => {
    const store = createProfileStore();
    expect(store.getProfiles()).toHaveLength(1);
    const def = store.getDefault();
    expect(def.id).toBe(DEFAULT_PROFILE_ID);
    expect(def.name).toBe("Default");
    expect(def.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(def.allowedTools.sort()).toEqual([...LLM_TOOL_NAMES].sort());
    expect(def.hookCommand).toBe("");
    expect(def.turnCommand).toBe("");
    expect(def.endCommand).toBe("");
    expect(def.maxToolTurns).toBe(100);
  });

  it("createProfile adds a new profile with every tool allowed and no subagent restrictions", () => {
    const store = createProfileStore();
    const p = store.createProfile("Reviewer");
    expect(store.getProfiles()).toHaveLength(2);
    expect(store.getProfile(p.id)).toEqual(p);
    expect(p.name).toBe("Reviewer");
    expect(p.systemPrompt).toBe("");
    expect(p.allowedTools.sort()).toEqual([...LLM_TOOL_NAMES].sort());
    expect(p.allowedSubagentProfiles).toEqual([]);
    expect(p.maxToolTurns).toBe(100);
  });

  it("updateProfile persists allowedSubagentProfiles, and the field survives a reload", () => {
    const store = createProfileStore();
    const p = store.createProfile("Reviewer");
    store.updateProfile(p.id, { allowedSubagentProfiles: [p.id] });
    store.persist();

    const updated = store.getProfile(p.id);
    expect(updated?.allowedSubagentProfiles).toEqual([p.id]);

    // A fresh store (simulating a page reload) must load the restriction
    // verbatim — it's part of the persisted shape now.
    const reloaded = createProfileStore();
    expect(reloaded.getProfile(p.id)?.allowedSubagentProfiles).toEqual([p.id]);
  });

  it("updateProfile merges a patch into the profile with that id", () => {
    const store = createProfileStore();
    const p = store.createProfile("Reviewer");
    store.updateProfile(p.id, {
      systemPrompt: "Review code for bugs.",
      allowedTools: ["read_file"],
      hookCommand: "git status",
    });

    const updated = store.getProfile(p.id);
    expect(updated?.systemPrompt).toBe("Review code for bugs.");
    expect(updated?.allowedTools).toEqual(["read_file"]);
    expect(updated?.hookCommand).toBe("git status");
    // Untouched fields survive the merge.
    expect(updated?.name).toBe("Reviewer");
  });

  it("updateProfile is a no-op for an unknown id", () => {
    const store = createProfileStore();
    store.updateProfile("nope", { name: "x" });
    expect(store.getProfiles()).toHaveLength(1);
  });

  it("deleteProfile removes a non-default profile and returns true", () => {
    const store = createProfileStore();
    const p = store.createProfile("Reviewer");
    expect(store.deleteProfile(p.id)).toBe(true);
    expect(store.getProfiles()).toHaveLength(1);
    expect(store.getProfile(p.id)).toBeUndefined();
  });

  it("deleteProfile refuses to delete the default profile", () => {
    const store = createProfileStore();
    expect(store.deleteProfile(DEFAULT_PROFILE_ID)).toBe(false);
    expect(store.getProfiles()).toHaveLength(1);
  });

  it("deleteProfile refuses an unknown id", () => {
    const store = createProfileStore();
    expect(store.deleteProfile("nope")).toBe(false);
  });

  it("persist() round-trips profiles across a new store", () => {
    const first = createProfileStore();
    const p = first.createProfile("Reviewer");
    first.updateProfile(p.id, { systemPrompt: "Review code." });
    first.persist();

    const second = createProfileStore();
    expect(second.getProfiles()).toHaveLength(2);
    expect(second.getProfile(p.id)?.systemPrompt).toBe("Review code.");
  });

  it("loads persisted profiles missing the default by re-seeding it", () => {
    storage.setItem(
      "vise:llm:profiles",
      JSON.stringify([
        {
          id: "custom",
          name: "Custom",
          systemPrompt: "",
          allowedTools: [],
          hookCommand: "",
          turnCommand: "",
          endCommand: "",
        },
      ])
    );

    const store = createProfileStore();
    expect(store.getProfiles()).toHaveLength(2);
    expect(store.getProfile(DEFAULT_PROFILE_ID)).toBeDefined();
    expect(store.getProfile("custom")).toBeDefined();
  });

  it("updateProfile persists maxToolTurns, and the field survives a reload", () => {
    const store = createProfileStore();
    const p = store.createProfile("Reviewer");
    store.updateProfile(p.id, { maxToolTurns: 25 });
    store.persist();

    expect(store.getProfile(p.id)?.maxToolTurns).toBe(25);

    // A fresh store (simulating a page reload) must load the value verbatim.
    const reloaded = createProfileStore();
    expect(reloaded.getProfile(p.id)?.maxToolTurns).toBe(25);
  });

  it("normalizes old persisted profiles (no maxToolTurns) to the default", () => {
    storage.setItem(
      "vise:llm:profiles",
      JSON.stringify([
        {
          id: "old",
          name: "Old",
          systemPrompt: "",
          allowedTools: ["read_file"],
          hookCommand: "",
          turnCommand: "",
          endCommand: "",
        },
      ])
    );

    const store = createProfileStore();
    expect(store.getProfile("old")?.maxToolTurns).toBe(100);
  });

  it("normalizes old persisted profiles (no allowedSubagentProfiles) to unrestricted", () => {
    storage.setItem(
      "vise:llm:profiles",
      JSON.stringify([
        {
          id: "old",
          name: "Old",
          systemPrompt: "",
          allowedTools: ["read_file"],
          hookCommand: "",
          turnCommand: "",
          endCommand: "",
        },
      ])
    );

    const store = createProfileStore();
    expect(store.getProfile("old")?.allowedSubagentProfiles).toEqual([]);
  });

  it("loads a persisted allowedSubagentProfiles restriction verbatim", () => {
    storage.setItem(
      "vise:llm:profiles",
      JSON.stringify([
        {
          id: "parent",
          name: "Parent",
          systemPrompt: "",
          allowedTools: ["read_file"],
          allowedSubagentProfiles: ["helper"],
          hookCommand: "",
          turnCommand: "",
          endCommand: "",
        },
        {
          id: "helper",
          name: "Helper",
          systemPrompt: "",
          allowedTools: ["read_file"],
          allowedSubagentProfiles: [],
          hookCommand: "",
          turnCommand: "",
          endCommand: "",
        },
      ])
    );

    const store = createProfileStore();
    expect(store.getProfile("parent")?.allowedSubagentProfiles).toEqual([
      "helper",
    ]);
  });
});
