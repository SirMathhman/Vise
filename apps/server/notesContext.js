import { listNotes } from "./notes.js";

// Per-conversation snapshot of the notes store, injected as a system message
// so the model can answer "what notes exist?" without a tool call. A snapshot
// is taken once per conversationId — on that conversation's first request —
// and stays constant for its lifetime, even if notes change mid-conversation
// (via the note tools), so the injected context is never stale within a
// conversation. An absent conversationId is treated as one-shot: a fresh
// snapshot is computed each time and never cached.
const notesSnapshots = new Map();

/**
 * Returns the notes snapshot for a conversation, taking one on first contact.
 * If the conversation is resumed (backend restarted since the conversation
 * started) and the frontend provides the snapshot it stored at conversation
 * start, that snapshot is used instead of building a fresh one, keeping the
 * system message consistent with the model's prior replies.
 * @param {string} conversationId - Stable id identifying the conversation. When absent (empty/undefined), a fresh snapshot is computed and not cached.
 * @param {string} [storedSnapshot] - Snapshot text stored by the frontend at conversation start, used to seed the cache on resume.
 * @returns {Promise<string>} The system message describing the notes at the start of this conversation.
 */
export async function getNotesContext(conversationId, storedSnapshot) {
  const key =
    typeof conversationId === "string" && conversationId
      ? conversationId
      : undefined;

  if (key !== undefined) {
    const cached = notesSnapshots.get(key);
    if (cached !== undefined) return cached;
  }

  let snapshot;
  if (
    key !== undefined &&
    typeof storedSnapshot === "string" &&
    storedSnapshot
  ) {
    snapshot = storedSnapshot;
  } else {
    snapshot = await buildSnapshot();
  }

  if (key !== undefined) notesSnapshots.set(key, snapshot);
  return snapshot;
}

/**
 * Builds a fresh snapshot from the current notes store without caching.
 * Used by the /api/notes-snapshot endpoint to seed the frontend's stored
 * snapshot when a conversation starts.
 * @returns {Promise<string>} The snapshot text.
 */
export async function buildSnapshot() {
  const notes = await listNotes();
  if (notes.length === 0) {
    return (
      "You have a persistent notes store. It is currently empty — no notes " +
      "are stored. Answer questions about what notes exist directly from " +
      "this fact (there are none); do not call recall_notes to list notes. " +
      "Use take_note to record something."
    );
  }
  const lines = notes.map((n) => `- ${n.title}: ${n.content}`);
  return (
    "You have a persistent notes store. The notes listed below are the " +
    "complete, current contents of the store at the start of this " +
    "conversation. Answer questions about what notes exist or what a " +
    "stored note says directly from this list — it is already given to " +
    "you, so do not call recall_notes to get the list. Only use " +
    "recall_notes if you need to confirm a note that may have been added " +
    "or changed during this conversation, which this list does not " +
    "reflect.\n" +
    lines.join("\n")
  );
}
