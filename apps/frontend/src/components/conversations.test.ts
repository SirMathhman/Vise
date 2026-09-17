import {
  type ChatMessage,
  createConversationStore,
  deriveTitle,
} from "./conversations.js";

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

function user(text: string): ChatMessage {
  return { role: "user", content: text };
}
function assistant(text: string): ChatMessage {
  return { role: "assistant", content: text };
}

describe("deriveTitle", () => {
  it("uses the first non-empty user message, trimmed and collapsed", () => {
    const msgs = [user("  hello\n   world "), assistant("hi")];
    expect(deriveTitle(msgs)).toBe("hello world");
  });

  it("truncates long titles to 48 chars with an ellipsis", () => {
    const t = "a".repeat(60);
    const out = deriveTitle([user(t)]);
    expect(out.length).toBe(48);
    expect(out.endsWith("…")).toBe(true);
  });

  it("skips empty/whitespace user messages", () => {
    const msgs = [user("   "), user("  real  ")];
    expect(deriveTitle(msgs)).toBe("real");
  });

  it("falls back to a generic label when there is no user message", () => {
    expect(deriveTitle([])).toBe("New conversation");
    expect(deriveTitle([], "abcd")).toBe("New conversation · abcd");
  });
});

describe("conversation store", () => {
  let storage: MemoryLocalStorage;

  beforeEach(() => {
    storage = new MemoryLocalStorage();
    (globalThis as Record<string, unknown>).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("seeds one empty conversation on first run", () => {
    const store = createConversationStore();
    expect(store.getConversations()).toHaveLength(1);
    expect(store.getActive().messages).toHaveLength(0);
    expect(store.activeId()).toBe(store.getConversations()[0].id);
  });

  it("appendMessage is the single append point on the active conversation", () => {
    const store = createConversationStore();
    store.appendMessage(user("hello"));
    store.appendMessage(assistant("hi"));
    expect(store.getActive().messages).toHaveLength(2);
    expect(store.getActive().messages[0]).toEqual(user("hello"));
  });

  it("rollbackTo truncates the active history", () => {
    const store = createConversationStore();
    store.appendMessage(user("one"));
    store.appendMessage(assistant("a1"));
    store.appendMessage(user("two"));
    store.rollbackTo(2);
    expect(store.getActive().messages).toHaveLength(2);
    expect(store.getActive().messages[1]).toEqual(assistant("a1"));
  });

  it("commitTurn records promptTokens, retitles, and persists", () => {
    const store = createConversationStore();
    store.appendMessage(user("my question"));
    store.appendMessage(assistant("an answer"));
    store.commitTurn({ promptTokens: 42 });

    expect(store.getPromptTokens(store.activeId())).toBe(42);
    expect(store.getActive().title).toBe("my question");

    const raw = storage.getItem("vise:llm:conversations");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed[0].title).toBe("my question");
  });

  it("persist() round-trips conversations across a new store", () => {
    const first = createConversationStore();
    first.appendMessage(user("persisted"));
    first.commitTurn();
    const activeId = first.activeId();

    const second = createConversationStore();
    const restored = second.getConversations().find((c) => c.id === activeId);
    expect(restored).toBeDefined();
    expect(restored?.messages).toHaveLength(1);
    expect(restored?.messages[0]).toEqual(user("persisted"));
  });

  it("newConversation prepends, activates, and clears prior tokens", () => {
    const store = createConversationStore();
    store.appendMessage(user("old"));
    store.commitTurn({ promptTokens: 7 });
    const oldId = store.activeId();

    store.newConversation("model-x");
    expect(store.getConversations()[0].id).not.toBe(oldId);
    expect(store.getActive().id).toBe(store.getConversations()[0].id);
    expect(store.getActive().model).toBe("model-x");
    expect(store.getPromptTokens(oldId)).toBe(7);
  });

  it("deleteConversation seeds a fresh one when it was the only one", () => {
    const store = createConversationStore();
    const onlyId = store.activeId();
    store.deleteConversation(onlyId);
    expect(store.getConversations()).toHaveLength(1);
    expect(store.getActive().id).not.toBe(onlyId);
  });

  it("deleteConversation activates the first remaining when the active is removed", () => {
    const store = createConversationStore();
    const firstId = store.activeId();
    store.newConversation("m");
    const secondId = store.activeId();

    store.deleteConversation(secondId);
    expect(store.activeId()).toBe(firstId);
  });
});

describe("conversation store - startup hook", () => {
  let storage: MemoryLocalStorage;

  beforeEach(() => {
    storage = new MemoryLocalStorage();
    (globalThis as Record<string, unknown>).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("a fresh conversation has no hook command and no hook output", () => {
    const store = createConversationStore();
    expect(store.getActive().hookCommand).toBe("");
    expect(store.getActive().hookOutput).toBeUndefined();
  });

  it("setHookCommand and setHookOutput mutate and persist the active conversation", () => {
    const store = createConversationStore();
    store.setHookCommand("git status");
    store.setHookOutput("On branch main");
    store.persist();

    expect(store.getActive().hookCommand).toBe("git status");
    expect(store.getActive().hookOutput).toBe("On branch main");

    const raw = storage.getItem("vise:llm:conversations");
    const parsed = JSON.parse(raw as string);
    expect(parsed[0].hookCommand).toBe("git status");
    expect(parsed[0].hookOutput).toBe("On branch main");
  });

  it("hookCommand/hookOutput round-trip across a new store", () => {
    const first = createConversationStore();
    first.setHookCommand("pnpm typecheck");
    first.setHookOutput("no errors");
    first.persist();
    const activeId = first.activeId();

    const second = createConversationStore();
    const restored = second.getConversations().find((c) => c.id === activeId);
    expect(restored?.hookCommand).toBe("pnpm typecheck");
    expect(restored?.hookOutput).toBe("no errors");
  });

  it("loads pre-hook persisted conversations with hookCommand defaulted to empty", () => {
    storage.setItem(
      "vise:llm:conversations",
      JSON.stringify([
        { id: "c1", title: "old", model: "m", messages: [user("hi")] },
      ])
    );
    storage.setItem("vise:llm:active", "c1");

    const store = createConversationStore();
    expect(store.getActive().hookCommand).toBe("");
    expect(store.getActive().hookOutput).toBeUndefined();
  });
});

describe("conversation store - turn hook", () => {
  let storage: MemoryLocalStorage;

  beforeEach(() => {
    storage = new MemoryLocalStorage();
    (globalThis as Record<string, unknown>).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("a fresh conversation has no turn command", () => {
    const store = createConversationStore();
    expect(store.getActive().turnCommand).toBe("");
  });

  it("setTurnCommand mutates and persists the active conversation", () => {
    const store = createConversationStore();
    store.setTurnCommand("date");
    store.persist();

    expect(store.getActive().turnCommand).toBe("date");

    const raw = storage.getItem("vise:llm:conversations");
    const parsed = JSON.parse(raw as string);
    expect(parsed[0].turnCommand).toBe("date");
  });

  it("turnCommand round-trips across a new store", () => {
    const first = createConversationStore();
    first.setTurnCommand("git status");
    first.persist();
    const activeId = first.activeId();

    const second = createConversationStore();
    const restored = second.getConversations().find((c) => c.id === activeId);
    expect(restored?.turnCommand).toBe("git status");
  });

  it("loads pre-turn-hook persisted conversations with turnCommand defaulted to empty", () => {
    storage.setItem(
      "vise:llm:conversations",
      JSON.stringify([
        { id: "c1", title: "old", model: "m", messages: [user("hi")] },
      ])
    );
    storage.setItem("vise:llm:active", "c1");

    const store = createConversationStore();
    expect(store.getActive().turnCommand).toBe("");
  });
});

describe("conversation store - end hook", () => {
  let storage: MemoryLocalStorage;

  beforeEach(() => {
    storage = new MemoryLocalStorage();
    (globalThis as Record<string, unknown>).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("a fresh conversation has no end command", () => {
    const store = createConversationStore();
    expect(store.getActive().endCommand).toBe("");
  });

  it("setEndCommand mutates and persists the active conversation", () => {
    const store = createConversationStore();
    store.setEndCommand("pnpm lint");
    store.persist();

    expect(store.getActive().endCommand).toBe("pnpm lint");

    const raw = storage.getItem("vise:llm:conversations");
    const parsed = JSON.parse(raw as string);
    expect(parsed[0].endCommand).toBe("pnpm lint");
  });

  it("endCommand round-trips across a new store", () => {
    const first = createConversationStore();
    first.setEndCommand("pnpm typecheck");
    first.persist();
    const activeId = first.activeId();

    const second = createConversationStore();
    const restored = second.getConversations().find((c) => c.id === activeId);
    expect(restored?.endCommand).toBe("pnpm typecheck");
  });

  it("loads pre-end-hook persisted conversations with endCommand defaulted to empty", () => {
    storage.setItem(
      "vise:llm:conversations",
      JSON.stringify([
        { id: "c1", title: "old", model: "m", messages: [user("hi")] },
      ])
    );
    storage.setItem("vise:llm:active", "c1");

    const store = createConversationStore();
    expect(store.getActive().endCommand).toBe("");
  });
});
