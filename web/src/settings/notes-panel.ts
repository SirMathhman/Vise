import { ifConfirmed } from "../feedback/confirm.ts";
import { make } from "../dom.ts";

/** One entry of the server's `notes` listing. */
interface NoteEntry {
  name: string;
  category: string;
  scope: string;
  summary: string;
}

/** The slice of a server message the notes panel reacts to. */
export interface NotesMessage {
  type: string;
  notes?: NoteEntry[];
  name?: string;
  category?: string;
  scope?: string;
  body?: string;
  ok?: boolean;
  version?: number;
  deleted?: boolean;
  error?: string;
}

const DEFAULT_CATEGORY = "default";
const DEFAULT_SCOPE = "project";

type NoteRef = { name: string; category: string; scope: string };

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
    const group = `${note.scope} · ${note.category}`;
    if (group !== last) {
      last = group;
      list.append(make("li", "list-group-title", group));
      if (note.category !== DEFAULT_CATEGORY) {
        categories.append(new Option(note.category));
      }
    }
    const item = make("li");
    const button = make("button", "list-item", note.name);
    button.title = note.summary;
    const selected =
      current?.name === note.name &&
      current.category === note.category &&
      current.scope === note.scope;
    button.setAttribute("aria-current", String(selected));
    button.addEventListener("click", () =>
      open({ name: note.name, category: note.category, scope: note.scope }),
    );
    item.append(button);
    list.append(item);
  }
  if (notes.length === 0) list.append(make("li", "list-empty", "No notes yet."));
}

/** Whether a server message is about the note `ref`. */
function isNote(ref: NoteRef | null, message: NotesMessage): boolean {
  return (
    ref !== null &&
    ref.name === message.name &&
    ref.category === message.category &&
    ref.scope === message.scope
  );
}

/** The save message: an edited note carries where it came from and the version it was loaded at. */
function savePayload(
  name: string,
  category: string,
  scope: string,
  body: string,
  current: NoteRef | null,
  version: number | undefined,
): Record<string, unknown> {
  return {
    type: "note_save",
    name,
    category,
    scope,
    body,
    ...(current ? { from: current, version } : {}),
  };
}

/** The panel's elements: the note list on the left, the editor on the right. */
function buildUi() {
  const list = make("ul", "list");
  const name = make("input", "field");
  name.placeholder = "Name";
  name.autocomplete = "off";
  const scope = make("select", "field");
  scope.append(new Option("Project (this folder only)", "project"));
  scope.append(new Option("Global (every folder)", "global"));
  scope.setAttribute("aria-label", "scope");
  const category = make("input", "field");
  category.placeholder = `category (empty: ${DEFAULT_CATEGORY})`;
  category.setAttribute("list", "note-categories");
  category.autocomplete = "off";
  const categories = make("datalist");
  categories.id = "note-categories";
  const text = make("textarea", "field");
  text.placeholder =
    "The first non-empty line is the note's summary; the rest is its body.";
  text.rows = 12;
  const status = make("span", "status-line");
  status.setAttribute("role", "status");
  const saveBtn = make("button", "btn btn--primary", "Save");
  const deleteBtn = make("button", "btn btn--danger", "Delete");
  const newBtn = make("button", "btn", "+ New note");

  const left = make("div", "two-pane__side");
  left.append(newBtn, list);
  const right = make("div", "two-pane__main");
  const buttons = make("div", "actions");
  buttons.append(saveBtn, deleteBtn, status);
  right.append(name, scope, category, categories, text, buttons);
  const layout = make("div", "two-pane");
  layout.append(left, right);
  return {
    layout,
    list,
    name,
    scope,
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
 * The "notes" settings tab: a list of the project's and the global notes grouped by scope and category
 * and an editor to create, edit, move/rename and delete them. It works on the
 * same notes store as the model's note tools and `/note`; the server reads and
 * writes it directly (`src/web/api/notes-api.ts`). Changing the name or category
 * of an existing note and saving moves it.
 */
export function createNotesPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  /** Elements whose click means the tab may now be visible: refresh the list. */
  refreshOn: HTMLElement[],
): { handle(message: NotesMessage): boolean } {
  /** The note being edited, or null for a new one. */
  let current: NoteRef | null = null;
  /** The file version the editor loaded; a save fails if the note changed since. */
  let version: number | undefined;
  let notes: NoteEntry[] = [];

  const {
    layout,
    list,
    name,
    scope,
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

  const edit = (target: NoteRef | null): void => {
    current = target;
    name.value = target?.name ?? "";
    scope.value = target?.scope ?? DEFAULT_SCOPE;
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
    say("Saving…");
    const fields = [
      name.value,
      category.value,
      scope.value,
      text.value,
    ] as const;
    send(savePayload(...fields, current, version));
  });
  deleteBtn.addEventListener("click", () => {
    const target = current;
    if (target) ifConfirmed({ title: `Delete the note “${target.name}”?` }, () => send({ type: "note_delete", ...target }));
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
          if (isNote(current, message)) {
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
            say("Deleted.");
          } else {
            // After a save the note is the one being edited (a rename moved it).
            current = {
              name: message.name ?? "",
              category: message.category ?? DEFAULT_CATEGORY,
              scope: message.scope ?? DEFAULT_SCOPE,
            };
            version = message.version;
            deleteBtn.disabled = false;
            say("Saved.");
          }
          return true;
        default:
          return false;
      }
    },
  };
}
