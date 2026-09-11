/**
 * Multi-conversation state, persistence, and switching. A DOM-less leaf module
 * that owns the full list of conversations the user has started and which one
 * is active, so the user can close out of a conversation, start a new one, and
 * reopen an old one.
 *
 * Each conversation is `{ id, sent, display, notesSnapshot }`. The title is
 * derived from the first user message (truncated) and not stored separately.
 *
 * `conversations` and `currentIndex` are exported as live bindings so the
 * chat behavior module can read them without a getter. All mutations go
 * through the functions below, so persistence has a single entry point
 * (`saveActive`).
 */

const STORAGE_KEY = "vise-chat";

const conversations = [];
let currentIndex = 0;

/**
 * Derive a short, human-readable title for a conversation from its first user
 * message. Strips the injected `[Context: ...]` suffix the chat appends,
 * trims, and truncates to 40 characters with an ellipsis. Falls back to a
 * placeholder for a conversation with no user messages yet.
 * @param {{ sent?: Array }} conv - The conversation to title.
 * @returns {string}
 */
export const titleFor = (conv) => {
  const first = conv.sent?.find((m) => m.role === "user");
  if (!first) return "New conversation";
  const text = first.content.replace(/\n+\[Context:.*\]$/, "", "s").trim();
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
};

const serialize = () => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ conversations, currentIndex }),
    );
  } catch {
    // Ignore quota or privacy-mode failures.
  }
};

/**
 * Read and migrate the persisted conversation list. Populates the module's
 * `conversations` array and `currentIndex`, then returns the active
 * conversation object, or `null` when there is nothing to restore (the caller
 * should start a fresh conversation).
 *
 * Handles three shapes, newest first:
 *   - `{ conversations, currentIndex }` (current)
 *   - a bare array of conversation objects (intermediate)
 *   - a single conversation object (legacy single-conversation format)
 * @returns {{ id: string, sent: Array, display: Array, notesSnapshot: string } | null}
 */
export const load = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);

    let list;
    let index = 0;
    if (
      parsed &&
      Array.isArray(parsed.conversations) &&
      typeof parsed.currentIndex === "number"
    ) {
      // Current format: { conversations, currentIndex }
      list = parsed.conversations;
      index = parsed.currentIndex;
    } else if (Array.isArray(parsed)) {
      // Intermediate format: a bare array of conversation objects.
      list = parsed;
      index = 0;
    } else if (
      parsed &&
      Array.isArray(parsed.sent) &&
      Array.isArray(parsed.display)
    ) {
      // Legacy format: a single conversation object.
      list = [
        {
          id: parsed.conversationId ?? crypto.randomUUID(),
          sent: parsed.sent,
          display: parsed.display,
          notesSnapshot: parsed.notesSnapshot ?? "",
        },
      ];
      index = 0;
    } else {
      return null;
    }

    conversations.push(...list);
    currentIndex = Math.min(index, conversations.length - 1);
    return conversations[currentIndex] ?? null;
  } catch {
    // Ignore corrupt storage.
  }
  return null;
};

/**
 * Append a fresh, empty conversation and make it active. Used when the user
 * clears (which now starts a new conversation rather than wiping history) and
 * on first load when there is nothing to restore.
 * @param {string} id - The new conversation's id (a UUID the caller minted).
 * @returns {{ id: string, sent: Array, display: Array, notesSnapshot: string }} The new entry.
 */
export const addConversation = (id) => {
  conversations.push({ id, sent: [], display: [], notesSnapshot: "" });
  currentIndex = conversations.length - 1;
  return conversations[currentIndex];
};

/**
 * Make the given index the active conversation. The caller is responsible for
 * restoring that conversation into its own live working set and calling
 * `saveActive` to persist the switch.
 * @param {number} idx - The index in `conversations` to activate.
 */
export const setActiveIndex = (idx) => {
  currentIndex = idx;
};

/**
 * Read the index of the active conversation. Exported as a getter (not a live
 * binding) so the chat module can read the value without being able to
 * reassign it; mutations go through `setActiveIndex` / `addConversation`.
 * @returns {number}
 */
export const getCurrentIndex = () => currentIndex;

/**
 * Persist the caller's live working set into the active conversation slot and
 * serialize to localStorage. This is the single persistence entry point: after
 * any change to a conversation's live state, the chat module calls this with
 * `{ id, sent, display, notesSnapshot }`.
 * @param {{ id: string, sent: Array, display: Array, notesSnapshot: string }} snapshot
 */
export const saveActive = (snapshot) => {
  conversations[currentIndex] = {
    id: snapshot.id,
    sent: [...snapshot.sent],
    display: [...snapshot.display],
    notesSnapshot: snapshot.notesSnapshot,
  };
  serialize();
};

// `conversations` is exported as a live array binding: the chat module iterates
// it to build its dropdown and reads `conversations[getCurrentIndex()]` for the
// active entry. Mutations to the collection go through `addConversation`,
// `setActiveIndex`, and `saveActive` so persistence has a single entry point.
export { conversations };
