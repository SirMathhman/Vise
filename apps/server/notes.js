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
