// The Notes panel: the notes list, the editor for one note, and the profile picker.

// Notes in the side panel. The server keeps them; the page shows one at a time in the editor below the list.
interface NoteRef {
  scope: string;
  category: string;
  name: string;
}

interface NoteInfo extends NoteRef {
  summary: string | null;
}

const notesList = document.getElementById("notes-list") as HTMLUListElement;
const notesStatus = document.getElementById("notes-status") as HTMLParagraphElement;
const notesNew = document.getElementById("notes-new") as HTMLButtonElement;
const noteForm = document.getElementById("note-form") as HTMLFormElement;
const noteScope = document.getElementById("note-scope") as HTMLSelectElement;
const noteCategory = document.getElementById("note-category") as HTMLInputElement;
const noteName = document.getElementById("note-name") as HTMLInputElement;
const noteContent = document.getElementById("note-content") as HTMLTextAreaElement;
const noteDelete = document.getElementById("note-delete") as HTMLButtonElement;
const notePreview = document.getElementById("note-preview") as HTMLDivElement;
const notePreviewToggle = document.getElementById("note-preview-toggle") as HTMLButtonElement;
const profilePicker = document.getElementById("profile-picker") as HTMLSelectElement;
const NEW_NOTE_TEXT = "---\nname: \nsummary: \n---\n";
// The note open in the editor. Null while a new note is being written.
let editing: NoteRef | null = null;

// One request to the notes API.
function notesApi<T>(body: Record<string, unknown>): Promise<T> {
  return postJson<T>("/api/notes", body);
}

function setEditing(note: NoteRef | null, text: string): void {
  editing = note;
  noteScope.value = note?.scope ?? "local";
  noteCategory.value = note?.category ?? "";
  noteName.value = note?.name ?? "";
  // An existing note keeps its address, so saving it cannot rename it.
  noteScope.disabled = note !== null;
  noteCategory.readOnly = note !== null;
  noteName.readOnly = note !== null;
  noteContent.value = text;
  noteDelete.hidden = note === null;
  showPreview(false);
}

// Shows the note's rendered markdown in place of the editor, or the editor again. Saving uses the editor's text.
function showPreview(on: boolean): void {
  noteContent.hidden = on;
  notePreview.hidden = !on;
  notePreviewToggle.textContent = on ? "Edit" : "Preview";
  if (on) {
    notePreview.innerHTML = renderMarkdown(noteContent.value);
  } else {
    fitNoteContent();
  }
}

// The editor is as tall as its text, so it never scrolls inside the Notes pane. The height includes the border, which
// scrollHeight leaves out.
function fitNoteContent(): void {
  noteContent.style.height = "auto";
  const border = noteContent.offsetHeight - noteContent.clientHeight;
  noteContent.style.height = `${noteContent.scrollHeight + border}px`;
}

noteContent.addEventListener("input", fitNoteContent);
// Wrapping changes with the width, and an editor inside a closed section has no height until it is opened. Both are
// measured again when the editor's size changes.
new ResizeObserver(fitNoteContent).observe(noteContent);

notePreviewToggle.addEventListener("click", () => showPreview(notePreview.hidden === true));

async function refreshNotes(): Promise<void> {
  try {
    const { notes: profiles } = await notesApi<{ notes: NoteRef[] }>({ action: "profiles" });
    profilePicker.replaceChildren(
      new Option("Use a profile…", ""),
      ...profiles.map((profile) => new Option(`${profile.scope} ${profile.category}/${profile.name}`, `${profile.scope}/${profile.category}/${profile.name}`)),
    );
    const { notes } = await notesApi<{ notes: NoteInfo[] }>({ action: "list" });
    notesList.replaceChildren(
      ...notes.map((note) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${note.scope} ${note.category}/${note.name}`;
        button.addEventListener("click", () => {
          void openNote({ scope: note.scope, category: note.category, name: note.name });
        });
        item.append(button);
        if (note.summary !== null) {
          const summary = document.createElement("div");
          summary.className = "description";
          summary.innerHTML = renderMarkdown(note.summary);
          item.append(summary);
        }
        return item;
      }),
    );
  } catch (err) {
    showStatus(notesStatus,errorMessage(err), true);
  }
}

async function openNote(note: NoteRef): Promise<void> {
  try {
    const { text } = await notesApi<{ text: string }>({ action: "read", ...note });
    setEditing(note, text);
    notesStatus.hidden = true;
  } catch (err) {
    showStatus(notesStatus,errorMessage(err), true);
  }
}

function newNote(): void {
  setEditing(null, NEW_NOTE_TEXT);
  notesStatus.hidden = true;
}

notesNew.addEventListener("click", newNote);

// Choosing a profile sends /profile through the chat, the same as typing it, so the reply and the instructions take
// the same path as any command.
profilePicker.addEventListener("change", () => {
  const ref = profilePicker.value;
  profilePicker.value = "";
  if (ref === "" || input.disabled) {
    return;
  }
  input.value = `/profile ${ref}`;
  form.requestSubmit();
});

noteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const note: NoteRef = editing ?? { scope: noteScope.value, category: noteCategory.value, name: noteName.value };
  try {
    const { message } = await notesApi<{ message: string }>({
      action: editing === null ? "create" : "update",
      ...note,
      content: noteContent.value,
    });
    setEditing(note, noteContent.value);
    showStatus(notesStatus,message, false);
    await refreshNotes();
  } catch (err) {
    showStatus(notesStatus,errorMessage(err), true);
  }
});

noteDelete.addEventListener("click", async () => {
  if (editing === null || !window.confirm(`Delete ${editing.scope} ${editing.category}/${editing.name}?`)) {
    return;
  }
  try {
    const { message } = await notesApi<{ message: string }>({ action: "delete", ...editing });
    newNote();
    showStatus(notesStatus,message, false);
    await refreshNotes();
  } catch (err) {
    showStatus(notesStatus,errorMessage(err), true);
  }
});

