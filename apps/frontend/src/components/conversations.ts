import type { LlmMessage } from "../api/client.js";

/** localStorage keys for the persisted conversations and the active one. */
const STORAGE_CONVS = "vise:llm:conversations";
const STORAGE_ACTIVE = "vise:llm:active";
/** Legacy single-conversation keys, read once for migration then ignored. */
const LEGACY_HISTORY = "vise:llm:history";
const LEGACY_MODEL = "vise:llm:model";

/**
 * A chat message. The optional `compaction` flag marks a model-generated
 * summary that stands in for all turns before it: when a compaction is
 * present, only that summary and the turns after it are sent to the model.
 * The message array is append-only — nothing before a summary is ever removed
 * from it, only bypassed in the outgoing prompt.
 */
export type ChatMessage = LlmMessage & { compaction?: true };

/**
 * A conversation is a self-contained chat: its message history plus the model
 * choice that belongs to it. Conversations are independent of one another and
 * are listed in the panel so the user can start new ones and reopen old ones.
 */
export interface Conversation {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
}

/** True when `value` is a structurally valid persisted message. */
function isValidMessage(value: unknown): value is LlmMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as LlmMessage).role in { user: true, assistant: true, tool: true } &&
    (typeof (value as LlmMessage).content === "string" ||
      (value as LlmMessage).content === null)
  );
}

/** True when `value` is a structurally valid persisted conversation. */
function isValidConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.title === "string" &&
    typeof c.model === "string" &&
    Array.isArray(c.messages) &&
    (c.messages as unknown[]).every(isValidMessage)
  );
}

/** Generate a unique id for a new conversation. */
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
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Derive a short display title from a conversation: the first user message,
 * trimmed and truncated. For an empty conversation, falls back to a generic
 * label; when `idSuffix` is given (a fragment of the conversation's id) it is
 * appended so several empty conversations stay distinguishable in the list.
 */
export function deriveTitle(
  messages: ChatMessage[],
  idSuffix?: string
): string {
  for (const m of messages) {
    if (
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.trim()
    ) {
      const t = m.content.trim().replace(/\s+/g, " ");
      return t.length > 48 ? `${t.slice(0, 47)}…` : t;
    }
  }
  return idSuffix ? `New conversation · ${idSuffix}` : "New conversation";
}

/** Persist every conversation and the active id across page reloads. */
function saveConversations(convs: Conversation[], activeId: string): void {
  try {
    localStorage.setItem(STORAGE_CONVS, JSON.stringify(convs));
    localStorage.setItem(STORAGE_ACTIVE, activeId);
  } catch {
    // Storage may be unavailable (private mode, quota); persistence is a
    // best-effort enhancement, so failures are ignored.
  }
}

/** Read the legacy single-conversation history, if any. */
function loadLegacyHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(LEGACY_HISTORY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMessage);
  } catch {
    return [];
  }
}

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadActiveId(): string | null {
  return safeGetItem(STORAGE_ACTIVE);
}

/**
 * Restore the persisted conversations. When none exist (first run) it
 * migrates the legacy single conversation into a one-item list, and returns
 * an empty list only when there is genuinely nothing to restore.
 */
function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_CONVS);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const convs = parsed.filter(isValidConversation);
        if (convs.length > 0) return convs;
      }
    }
    const legacy = loadLegacyHistory();
    if (legacy.length > 0) {
      return [
        {
          id: newId(),
          title: deriveTitle(legacy),
          model: safeGetItem(LEGACY_MODEL) ?? "",
          messages: legacy,
        },
      ];
    }
  } catch {
    return [];
  }
  return [];
}

/**
 * A stateful conversation store for the LLM panel. It owns the conversation
 * list, the active conversation, and per-conversation metrics (token usage and
 * context windows), and persists across page reloads. The panel (llm.ts) is a
 * thin DOM controller over this store: it renders `getConversations()` /
 * `getActive()` and forwards user actions to the mutators.
 */
export interface ConversationStore {
  /** The id of the active conversation. */
  activeId(): string;
  /** The active conversation. */
  getActive(): Conversation;
  /** All conversations, in display order. */
  getConversations(): Conversation[];
  /** Latest prompt-token count for a conversation, if any. */
  getPromptTokens(id: string): number | undefined;
  /** Record the latest prompt-token count for a conversation. */
  setPromptTokens(id: string, n: number): void;
  /** Context window (n_ctx) for a model id, if known. */
  getContextWindow(model: string): number | undefined;
  /** Record a model's context window (n_ctx). */
  setContextWindow(model: string, n: number): void;
  /** Start a new empty conversation (inheriting `model`) and activate it. */
  newConversation(model: string): void;
  /** Switch the active conversation to the one with this id. */
  switchTo(id: string): void;
  /**
   * Delete the conversation with this id (and its history). If it was active,
   * the first remaining conversation becomes active; if it was the only one, a
   * fresh empty conversation is seeded so the store keeps at least one.
   */
  deleteConversation(id: string): void;
  /** Set the active conversation's model choice. */
  setActiveModel(model: string): void;
  /** Retitle the active conversation from its first user message. */
  retitleActive(): void;
  /** Append a message to the active conversation (the single append point). */
  appendMessage(msg: ChatMessage): void;
  /** Truncate the active history back to `n` messages (failure rollback). */
  rollbackTo(n: number): void;
  /**
   * Atomically commit a completed chat turn: record the turn's prompt-token
   * count, retitle the conversation from its first user message, and persist.
   * The single gate the panel uses after a successful turn, so the store's
   * retitle/persist/token invariants can't be forgotten by a caller.
   */
  commitTurn(usage?: { promptTokens: number }): void;
  /** Persist the store. */
  persist(): void;
}

/** Build a conversation store from persisted state (with legacy migration). */
export function createConversationStore(): ConversationStore {
  let convs: Conversation[] = loadConversations();
  let activeId: string = loadActiveId() ?? "";

  // Always keep at least one conversation so getActive() is total: seed a
  // fresh empty one on first run.
  if (convs.length === 0) {
    const id = newId();
    convs = [
      { id, title: deriveTitle([], id.slice(0, 4)), model: "", messages: [] },
    ];
  }
  // Pick the active conversation: a stored id if it still exists, else the
  // first restored one.
  if (!convs.some((c) => c.id === activeId)) {
    activeId = convs[0].id;
  }

  /** Per-conversation token usage, so each resumed chat shows its own %. */
  const promptTokens = new Map<string, number>();
  /** Context window (n_ctx) for each model id, as reported by the proxy. */
  const contextWindow = new Map<string, number>();

  const getActive = (): Conversation =>
    convs.find((c) => c.id === activeId) ?? convs[0];

  return {
    activeId: () => activeId,
    getActive,
    getConversations: () => convs,
    getPromptTokens: (id) => promptTokens.get(id),
    setPromptTokens: (id, n) => {
      promptTokens.set(id, n);
    },
    getContextWindow: (model) => contextWindow.get(model),
    setContextWindow: (model, n) => {
      contextWindow.set(model, n);
    },
    newConversation(model) {
      const id = newId();
      convs = [
        { id, title: deriveTitle([], id.slice(0, 4)), model, messages: [] },
        ...convs,
      ];
      activeId = id;
      promptTokens.delete(id);
    },
    switchTo(id) {
      if (convs.some((c) => c.id === id)) activeId = id;
    },
    deleteConversation(id) {
      if (!convs.some((c) => c.id === id)) return;
      promptTokens.delete(id);
      convs = convs.filter((c) => c.id !== id);
      if (convs.length === 0) {
        const fresh = newId();
        convs = [
          {
            id: fresh,
            title: deriveTitle([], fresh.slice(0, 4)),
            model: "",
            messages: [],
          },
        ];
        activeId = fresh;
      } else if (activeId === id) {
        activeId = convs[0].id;
      }
    },
    setActiveModel(model) {
      getActive().model = model;
    },
    retitleActive() {
      const active = getActive();
      active.title = deriveTitle(active.messages);
    },
    appendMessage(msg) {
      getActive().messages.push(msg);
    },
    rollbackTo(n) {
      getActive().messages.length = n;
    },
    commitTurn(usage) {
      if (usage) promptTokens.set(activeId, usage.promptTokens);
      const active = getActive();
      active.title = deriveTitle(active.messages);
      saveConversations(convs, activeId);
    },
    persist() {
      saveConversations(convs, activeId);
    },
  };
}
