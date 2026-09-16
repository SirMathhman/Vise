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
