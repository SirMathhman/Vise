import type { ProviderEntry, ProviderInput } from "../../../protocol/protocol.ts";
import { panelBox } from "../mcp-view.ts";

// The providers (OpenRouter accounts and llama.cpp servers), as a panel that lists them and an editor that changes them. The page never has a key: a
// key field is blank, a blank key keeps the saved one, and a typed key replaces it.

export interface ProvidersActions {
  writeProviders(servers: ProviderInput[]): void;
}

export interface ProvidersSection {
  section: HTMLElement;
  dialog: HTMLDialogElement;
  update(servers: ProviderEntry[], sendable: boolean): void;
}

export function createProvidersSection(doc: Document, actions: ProvidersActions): ProvidersSection {
  const box = panelBox(doc);
  const dialog = doc.createElement("dialog");
  dialog.className = "profile-editor";
  let key = "";
  return {
    section: box.element,
    dialog,
    update(servers, sendable) {
      const next = JSON.stringify([servers, sendable]);
      if (next === key) return;
      key = next;
      const lines = servers.map((server) =>
        hint(doc, `${server.kind} (${server.scope ?? "local"}): ${server.name}${server.url ? ` at ${server.url}` : ""}`),
      );
      const edit = doc.createElement("button");
      edit.type = "button";
      edit.className = "session";
      edit.textContent = "Edit providers";
      edit.disabled = !sendable;
      edit.addEventListener("click", () => openEditor(doc, dialog, servers, actions));
      box.show("Providers", servers.length, [
        ...(lines.length === 0 ? [hint(doc, "none yet: Edit providers adds one")] : lines),
        edit,
      ]);
    },
  };
}

function hint(doc: Document, text: string): HTMLElement {
  const span = doc.createElement("span");
  span.className = "hint";
  span.textContent = text;
  return span;
}

// One provider's row in the editor: its kind, its name, its URL (llama.cpp only), its key (blank keeps the saved
// one), and a remove button.
interface Row {
  element: HTMLElement;
  read(): ProviderInput;
}

function rowOf(doc: Document, server?: ProviderEntry): Row {
  const element = doc.createElement("div");
  element.className = "server-row";
  const kind = doc.createElement("select");
  for (const choice of KINDS) {
    const option = doc.createElement("option");
    option.value = choice;
    option.textContent = choice;
    kind.append(option);
  }
  kind.value = server?.kind ?? "openrouter";
  const scope = doc.createElement("select");
  for (const choice of ["local", "global"] as const) {
    const option = doc.createElement("option");
    option.value = choice;
    option.textContent = choice;
    option.selected = choice === (server?.scope ?? "local");
    scope.append(option);
  }
  const name = input(doc, "text", server?.name ?? "", "name");
  const url = input(doc, "text", server?.url ?? "", "URL");
  const showUrl = () => {
    url.hidden = kind.value !== "llama.cpp";
  };
  kind.addEventListener("change", showUrl);
  showUrl();
  const apiKey = input(doc, "password", "", server?.keySaved ? "key saved: leave blank to keep it" : "key");
  apiKey.autocomplete = "off";
  const remove = doc.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => element.remove());
  element.append(kind, scope, name, url, apiKey, remove);
  return {
    element,
    read: () => ({
      kind: kind.value === "llama.cpp" ? "llama.cpp" : "openrouter",
      name: name.value.trim(),
      url: url.value.trim(),
      apiKey: apiKey.value,
      scope: scope.value === "global" ? "global" : "local",
    }),
  };
}

const KINDS: ProviderInput["kind"][] = ["openrouter", "llama.cpp"];

function input(doc: Document, type: string, value: string, placeholder: string): HTMLInputElement {
  const field = doc.createElement("input");
  field.type = type;
  field.value = value;
  field.placeholder = placeholder;
  return field;
}

// The editor. Save sends every row, and the page's rows replace the list; a provider left out is removed.
function openEditor(doc: Document, dialog: HTMLDialogElement, servers: ProviderEntry[], actions: ProvidersActions): void {
  const rows: Row[] = servers.map((server) => rowOf(doc, server));
  const list = doc.createElement("fieldset");
  list.append(...rows.map((row) => row.element));
  const add = doc.createElement("button");
  add.type = "button";
  add.textContent = "Add provider";
  add.addEventListener("click", () => {
    const row = rowOf(doc);
    rows.push(row);
    list.append(row.element);
  });
  const save = doc.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    actions.writeProviders(rows.map((row) => row.read()).filter((server) => server.name !== ""));
    dialog.close();
  });
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close());
  const heading = doc.createElement("h2");
  heading.textContent = "Providers";
  const note = hint(doc, "a change applies at the next start");
  dialog.replaceChildren(heading, note, list, add, save, cancel);
  dialog.showModal();
}
