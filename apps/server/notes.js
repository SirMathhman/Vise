import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Notes live outside the repository, in the user's home directory, so they
// persist across backend restarts without appearing in the browsed file
// tree. A note is a single titled unit of consolidated knowledge: the
// agent's current understanding of a topic, not a transcript of the chat.
const notesDir = join(homedir(), ".vise-notes");
const notesPath = join(notesDir, "notes.json");

/**
 * Loads the stored notes. Returns an empty array when none exist yet. A
 * missing or unparseable file is treated as empty (rather than fatal) so a
 * single bad write can't wedge the agent; the next upsert rewrites the file.
 * @returns {Promise<Array<{title: string, content: string, updatedAt: string}>>}
 */
export async function loadNotes() {
  try {
    const raw = await readFile(notesPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return err.code === "ENOENT" ? [] : [];
  }
}

/**
 * Persists the notes store, creating the notes directory on first write.
 * @param {Array<{title: string, content: string, updatedAt: string}>} notes
 * @returns {Promise<void>}
 */
export async function saveNotes(notes) {
  await mkdir(dirname(notesPath), { recursive: true });
  await writeFile(notesPath, JSON.stringify(notes, null, 2), "utf8");
}

/**
 * Upserts a note by title (case-insensitive). An existing note with the same
 * title is updated in place — preserving its original title casing — and a
 * new title is appended. This models "taking a note" as consolidating the
 * agent's understanding of a topic rather than piling up near-duplicates.
 * @param {string} title - The note's title.
 * @param {string} content - The note's body.
 * @returns {Promise<{note: {title: string, content: string, updatedAt: string}, updated: boolean}>}
 */
export async function upsertNote(title, content) {
  const notes = await loadNotes();
  const key = title.toLowerCase();
  const now = new Date().toISOString();
  const existing = notes.find((n) => n.title.toLowerCase() === key);
  if (existing) {
    existing.content = content;
    existing.updatedAt = now;
    await saveNotes(notes);
    return { note: existing, updated: true };
  }
  const note = { title, content, updatedAt: now };
  notes.push(note);
  await saveNotes(notes);
  return { note, updated: false };
}

/**
 * Counts how many times a string occurs in a string, counting overlapping
 * occurrences (e.g. "aa" in "aaa" is 2). Returns 0 for an empty needle.
 * @param {string} haystack - The string to search within.
 * @param {string} needle - The non-empty substring to count.
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    count += 1;
    start = index + 1;
  }
  return count;
}

/**
 * Performs a literal (exact, case-sensitive) string replacement in a single
 * note's content, by title. Unlike upsertNote, this preserves every part of
 * the note except the exact `oldString` (replaced by `newString`) — it is how
 * the agent amends a note with a precise edit rather than rewriting it.
 *
 * The note must already exist (look it up with recall_notes). `oldString`
 * must appear in the note's content exactly once — if it appears more than
 * once, nothing is changed and a message reports the ambiguity; if it does
 * not appear, nothing is changed and a message reports that. An empty
 * `newString` deletes `oldString`. A zero-length `newString` is a no-op when
 * `oldString` is empty.
 *
 * @param {string} title - The note's title (case-insensitive).
 * @param {string} oldString - The exact text to replace.
 * @param {string} newString - The exact text to replace it with.
 * @returns {Promise<{ok: boolean, note: {title: string, content: string, updatedAt: string}|null, occurrences: number, reason?: string}>}
 */
export async function updateNote(title, oldString, newString) {
  const notes = await loadNotes();
  const key = title.toLowerCase();
  const note = notes.find((n) => n.title.toLowerCase() === key);
  if (!note) {
    return {
      ok: false,
      note: null,
      occurrences: 0,
      reason: `No note titled "${title}" exists. Use recall_notes to find the exact title, or take_note to create it.`,
    };
  }
  const occurrences = countOccurrences(note.content, oldString);
  if (occurrences === 0) {
    return {
      ok: false,
      note,
      occurrences: 0,
      reason: `No occurrence of the previous string in note "${note.title}". Recall the note to see its exact current content.`,
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      note,
      occurrences,
      reason: `The previous string appears ${occurrences} times in note "${note.title}". Add more surrounding context to old_string to make it unique, or take_note with a fresh title.`,
    };
  }
  const newContent = note.content.replace(oldString, newString);
  note.content = newContent;
  note.updatedAt = new Date().toISOString();
  await saveNotes(notes);
  return { ok: true, note, occurrences: 1 };
}

/**
 * Returns every stored note whose title or content matches a case-insensitive
 * regex.
 * @param {RegExp} re - The regex to match against each note's title and content.
 * @returns {Promise<Array<{title: string, content: string, updatedAt: string}>>}
 */
export async function searchNotes(re) {
  const notes = await loadNotes();
  return notes.filter((n) => re.test(n.title) || re.test(n.content));
}

/**
 * Returns every stored note, sorted by title.
 * @returns {Promise<Array<{title: string, content: string, updatedAt: string}>>}
 */
export async function listNotes() {
  const notes = await loadNotes();
  return [...notes].sort((a, b) => a.title.localeCompare(b.title));
}
