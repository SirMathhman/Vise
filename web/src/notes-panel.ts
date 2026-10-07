/** One entry of the server's `notes` listing. */
interface NoteEntry {
  name: string;
  category: string;
  summary: string;
}

/** The slice of a server message the notes panel reacts to. */
export interface NotesMessage {
  type: string;
  notes?: NoteEntry[];
  name?: string;
  category?: string;
  body?: string;
  ok?: boolean;
  version?: number;
  deleted?: boolean;
  error?: string;
}

const DEFAULT_CATEGORY = "default";

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

type NoteRef = { name: string; category: string };

/** Fill the note list (grouped under category headings) and the category suggestions. */
function renderNotes(
  list: HTMLElement,
  categories: HTMLElement,
  notes: NoteEntry[],
  current: NoteRef | null,
  open: (target: NoteRef) => void,
): void {
  list.textContent = "";
  categories.textContent = "";
  let last = "";
  for (const note of notes) {
    if (note.category !== last) {
      last = note.category;
      list.append(make("li", "note-group", note.category));
      if (note.category !== DEFAULT_CATEGORY) {
        categories.append(new Option(note.category));
      }
    }
    const item = make("li");
    const button = make("button", "note-item", note.name);
    button.title = note.summary;
    const selected =
      current?.name === note.name && current.category === note.category;
    button.setAttribute("aria-current", String(selected));
    button.addEventListener("click", () =>
      open({ name: note.name, category: note.category }),
    );
    item.append(button);
    list.append(item);
  }
  if (notes.length === 0) list.append(make("li", "note-group", "no notes yet"));
}

/** The panel's elements: the note list on the left, the editor on the right. */
function buildUi() {
  const list = make("ul", "tools-list");
  const name = make("input", "save-input");
  name.placeholder = "name";
  name.autocomplete = "off";
  const category = make("input", "save-input");
  category.placeholder = `category (empty: ${DEFAULT_CATEGORY})`;
  category.setAttribute("list", "note-categories");
  category.autocomplete = "off";
  const categories = make("datalist");
  categories.id = "note-categories";
  const text = make("textarea", "note-text");
  text.placeholder =
    "The first non-empty line is the note's summary; the rest is its body.";
  text.rows = 12;
  const status = make("span", "pe-status");
  status.setAttribute("role", "status");
  const saveBtn = make("button", "save-btn", "save");
  const deleteBtn = make("button", "tools-btn", "delete");
  const newBtn = make("button", "tools-btn", "+ new note");

  const left = make("div", "notes-side");
  left.append(newBtn, list);
  const right = make("div", "notes-edit");
  const buttons = make("div", "save-row");
  buttons.append(saveBtn, deleteBtn, status);
  right.append(name, category, categories, text, buttons);
  const layout = make("div", "notes-layout");
  layout.append(left, right);
  return {
    layout,
    list,
    name,
    category,
    categories,
    text,
    status,
    saveBtn,
    deleteBtn,
    newBtn,
  };
}

/**
 * The "notes" settings tab: a list of the project's notes grouped by category
 * and an editor to create, edit, move/rename and delete them. It works on the
 * same notes store as the model's note tools and `/note`; the server reads and
 * writes it directly (`src/web/notes-api.ts`). Changing the name or category
 * of an existing note and saving moves it.
 */
export function createNotesPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  /** Elements whose click means the tab may now be visible: refresh the list. */
  refreshOn: HTMLElement[],
): { handle(message: NotesMessage): boolean } {
  /** The note being edited, or null for a new one. */
  let current: { name: string; category: string } | null = null;
  /** The file version the editor loaded; a save fails if the note changed since. */
  let version: number | undefined;
  let notes: NoteEntry[] = [];

  const {
    layout,
    list,
    name,
    category,
    categories,
    text,
    status,
    saveBtn,
    deleteBtn,
    newBtn,
  } = buildUi();

  const say = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };

  const edit = (target: { name: string; category: string } | null): void => {
    current = target;
    name.value = target?.name ?? "";
    category.value =
      target && target.category !== DEFAULT_CATEGORY ? target.category : "";
    text.value = "";
    version = undefined;
    // An existing note cannot be saved until its text has arrived (it would save a blank body).
    saveBtn.disabled = target !== null;
    deleteBtn.disabled = target === null;
    say("");
    renderList();
    if (target) send({ type: "note_get", ...target });
    else name.focus();
  };

  function renderList(): void {
    renderNotes(list, categories, notes, current, edit);
  }

  newBtn.addEventListener("click", () => edit(null));
  saveBtn.addEventListener("click", () => {
    say("saving…");
    send({
      type: "note_save",
      name: name.value,
      category: category.value,
      body: text.value,
      ...(current ? { from: current, version } : {}),
    });
  });
  deleteBtn.addEventListener("click", () => {
    if (!current || !confirm(`Delete note '${current.name}'?`)) return;
    send({ type: "note_delete", ...current });
  });
  for (const trigger of refreshOn) {
    trigger.addEventListener("click", () => send({ type: "notes_list" }));
  }

  body.append(layout);
  edit(null);

  return {
    handle(message) {
      switch (message.type) {
        case "notes":
          notes = message.notes ?? [];
          renderList();
          return true;
        case "note":
          // Ignore a reply for a note that is no longer the one being edited.
          if (
            current &&
            current.name === message.name &&
            current.category === message.category
          ) {
            text.value = message.body ?? "";
            version = message.version;
            saveBtn.disabled = false;
          }
          return true;
        case "note_result":
          if (!message.ok) {
            say(message.error ?? "failed", true);
          } else if (message.deleted) {
            edit(null);
            say("deleted");
          } else {
            // After a save the note is the one being edited (a rename moved it).
            current = {
              name: message.name ?? "",
              category: message.category ?? DEFAULT_CATEGORY,
            };
            version = message.version;
            deleteBtn.disabled = false;
            say("saved");
          }
          return true;
        default:
          return false;
      }
    },
  };
}
