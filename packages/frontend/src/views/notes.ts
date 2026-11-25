import type { Note, NoteInput } from "common";
import { NoteSchema, NotesResponseSchema } from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";

const notesStatus = requireElement("notes-status") as HTMLParagraphElement;
const notesSelect = requireElement("notes-select") as HTMLSelectElement;
const notesRefresh = requireElement("notes-refresh") as HTMLButtonElement;
const notesForm = requireElement("notes-form") as HTMLFormElement;
const notesName = requireElement("notes-name") as HTMLInputElement;
const notesCategory = requireElement("notes-category") as HTMLInputElement;
const notesSummary = requireElement("notes-summary") as HTMLInputElement;
const notesContent = requireElement("notes-content") as HTMLTextAreaElement;
const notesDelete = requireElement("notes-delete") as HTMLButtonElement;
const notesError = requireElement("notes-error") as HTMLParagraphElement;

const NOTES_PATH = "/api/notes";

// The value of the picker's first entry, which starts a new note.
const NEW_NOTE = "";

// The notes as last loaded. The picker and the form are filled from this list.
let notes: Note[] = [];

function fillForm(note: Note | undefined): void {
  notesName.value = note?.name ?? "";
  notesCategory.value = note?.category ?? "";
  notesSummary.value = note?.summary ?? "";
  notesContent.value = note?.content ?? "";
}

function renderPicker(selectedId: string): void {
  const entries = notes.map(
    (note) => new Option(`${note.name} (${note.category})`, note.id),
  );
  notesSelect.replaceChildren(new Option("New note", NEW_NOTE), ...entries);
  notesSelect.value = selectedId;
}

function selectedNote(): Note | undefined {
  return notes.find((note) => note.id === notesSelect.value);
}

// Shows the picked note in the form. An id that no longer exists starts a new note.
function showSelection(): void {
  notesError.textContent = "";
  fillForm(selectedNote());
}

/**
 * Loads every note from the backend and shows them in the picker.
 *
 * @param selectId The id to keep selected when it is still in the list.
 */
export async function loadNotes(selectId = notesSelect.value): Promise<void> {
  const result = await apiJson(NOTES_PATH, NotesResponseSchema);
  if (!result.ok) {
    notesStatus.textContent = `Unavailable: ${result.error}`;
    return;
  }
  notes = result.value.notes;
  renderPicker(
    notes.some((note) => note.id === selectId) ? selectId : NEW_NOTE,
  );
  showSelection();
  notesStatus.textContent = `${String(notes.length)} note${notes.length === 1 ? "" : "s"}`;
}

async function saveNote(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  notesError.textContent = "";
  const body: NoteInput = {
    name: notesName.value,
    category: notesCategory.value,
    summary: notesSummary.value,
    content: notesContent.value,
  };
  const id = notesSelect.value;
  const path =
    id === NEW_NOTE ? NOTES_PATH : `${NOTES_PATH}/${encodeURIComponent(id)}`;
  const result = await apiJson(path, NoteSchema, {
    method: id === NEW_NOTE ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    notesError.textContent = result.error;
    return;
  }
  await loadNotes(result.value.id);
}

async function deleteNote(): Promise<void> {
  const id = notesSelect.value;
  if (id === NEW_NOTE) {
    return;
  }
  notesError.textContent = "";
  const result = await apiJson(
    `${NOTES_PATH}/${encodeURIComponent(id)}`,
    NoteSchema,
    { method: "DELETE" },
  );
  if (!result.ok) {
    notesError.textContent = result.error;
    return;
  }
  await loadNotes(NEW_NOTE);
}

/**
 * Connects the notes picker, form, and controls.
 */
export function initNotes(): void {
  notesSelect.addEventListener("change", showSelection);
  notesRefresh.addEventListener("click", () => void loadNotes());
  notesForm.addEventListener("submit", (event) => void saveNote(event));
  notesDelete.addEventListener("click", () => void deleteNote());
}
