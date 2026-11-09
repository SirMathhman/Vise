import type { McpServerEntry, McpServerStatus } from "../../protocol/protocol.ts";
import type { McpInfo } from "./state.ts";

// What the MCP section asks the page to do: save the servers the editor shows.
export interface McpActions {
  writeMcp(servers: McpServerEntry[]): void;
}

// One server row of the editor. A program shows its command and arguments, an endpoint its url and headers;
// the kind decides which fields are shown.
interface ServerRow {
  element: HTMLElement;
  kind: HTMLSelectElement;
  name: HTMLInputElement;
  command: HTMLInputElement;
  args: HTMLTextAreaElement;
  url: HTMLInputElement;
  headers: HTMLTextAreaElement;
  stdioFields: HTMLElement;
  httpFields: HTMLElement;
}

// Every piece of text is set with textContent, never as HTML.
function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// What a configured server looks like in this session: started, not started, or added after the start.
function statusOf(name: string, running: McpServerStatus[]): string {
  const status = running.find((candidate) => candidate.name === name);
  if (status === undefined) return "added since the start: it starts at the next start";
  if (!status.started) return "did not start";
  return `started, ${status.tools.length} tools`;
}

// The servers, each with its state, the problems that stopped one, and a button that opens the editor.
export function mcpPanel(
  doc: Document,
  info: McpInfo | undefined,
  enabled: boolean,
  edit: () => void,
): HTMLElement[] {
  const heading = element(doc, "span", "label", "MCP servers");
  const servers = info?.servers ?? [];
  const running = info?.running ?? [];
  const lines: HTMLElement[] =
    servers.length === 0
      ? [element(doc, "span", "hint", "none yet: Edit servers adds one")]
      : servers.map((server) => element(doc, "span", "hint", `${server.name}: ${statusOf(server.name, running)}`));
  const problems = running.flatMap((status) =>
    status.problems.map((problem) => element(doc, "span", "hint", `${status.name}: ${problem}`)),
  );
  const button = element(doc, "button", "session", "Edit servers");
  button.disabled = !enabled;
  button.addEventListener("click", edit);
  return [heading, ...lines, ...problems, button];
}

// A labelled input for a row's field.
function field(doc: Document, input: HTMLInputElement | HTMLTextAreaElement, label: string): HTMLElement {
  const wrapper = doc.createElement("label");
  wrapper.className = "field";
  wrapper.append(element(doc, "span", "", label), input);
  return wrapper;
}

// Headers as the editor shows them: one "Name: value" line each.
function headerLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

// Reads "Name: value" lines back. A line with no colon is a header name with an empty value, and the store
// refuses a name that is not valid.
function headersOf(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      headers[trimmed] = "";
    } else {
      headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
    }
  }
  return headers;
}

// One row of the editor, filled from a server or empty. Changing the kind shows the fields that kind uses.
function rowOf(doc: Document, server: McpServerEntry, remove: (row: ServerRow) => void): ServerRow {
  const row = doc.createElement("div");
  row.className = "server-row";
  const kind = doc.createElement("select");
  for (const [value, text] of [["stdio", "program"], ["http", "endpoint"]] as const) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = value === server.kind;
    kind.append(option);
  }
  const name = doc.createElement("input");
  name.type = "text";
  name.value = server.name;
  name.placeholder = "name";
  const command = doc.createElement("input");
  command.type = "text";
  command.value = server.kind === "stdio" ? server.command : "";
  command.placeholder = "command";
  const args = doc.createElement("textarea");
  args.rows = 2;
  args.value = server.kind === "stdio" ? server.args.join("\n") : "";
  args.placeholder = "one argument per line";
  const url = doc.createElement("input");
  url.type = "text";
  url.value = server.kind === "http" ? server.url : "";
  url.placeholder = "https://";
  const headers = doc.createElement("textarea");
  headers.rows = 2;
  headers.value = server.kind === "http" ? headerLines(server.headers) : "";
  headers.placeholder = "one header per line, as Name: value; a blank value keeps the stored one";
  const stdioFields = doc.createElement("div");
  stdioFields.append(field(doc, command, "Command"), field(doc, args, "Arguments"));
  const httpFields = doc.createElement("div");
  httpFields.append(field(doc, url, "URL"), field(doc, headers, "Headers"));
  const removeButton = element(doc, "button", "", "Remove");
  removeButton.type = "button";
  const entry: ServerRow = { element: row, kind, name, command, args, url, headers, stdioFields, httpFields };
  const showKind = (): void => {
    stdioFields.hidden = kind.value !== "stdio";
    httpFields.hidden = kind.value !== "http";
  };
  kind.addEventListener("change", showKind);
  showKind();
  removeButton.addEventListener("click", () => remove(entry));
  row.append(kind, name, stdioFields, httpFields, removeButton);
  return entry;
}

// Reads a row back into a server. Blank argument lines are dropped; the fields of the other kind are not sent.
function serverOf(row: ServerRow): McpServerEntry {
  const name = row.name.value.trim();
  if (row.kind.value === "http") {
    return { kind: "http", name, url: row.url.value.trim(), headers: headersOf(row.headers.value) };
  }
  return {
    kind: "stdio",
    name,
    command: row.command.value.trim(),
    args: row.args.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  };
}

// What the editor is opened with: its dialog, the servers as they are, whether the page may save, and the actions.
interface McpEditorOpen {
  dialog: HTMLDialogElement;
  info: McpInfo | undefined;
  canSave(): boolean;
  actions: McpActions;
}

// Opens the server editor in the dialog. Save sends every row, and the store checks them; Cancel only
// closes the dialog. A saved change applies at the next start of Vise.
export function openMcpEditor(doc: Document, open: McpEditorOpen): void {
  const { dialog, info, canSave, actions } = open;
  const rows: ServerRow[] = [];
  const list = doc.createElement("div");
  const remove = (row: ServerRow): void => {
    rows.splice(rows.indexOf(row), 1);
    row.element.remove();
  };
  const addRow = (server: McpServerEntry): void => {
    const row = rowOf(doc, server, remove);
    rows.push(row);
    list.append(row.element);
  };
  for (const server of info?.servers ?? []) addRow(server);

  const form = doc.createElement("div");
  form.append(element(doc, "h2", "", "MCP servers"));
  form.append(element(doc, "p", "hint", "Saved servers start at the next start of Vise."));
  form.append(list);
  const add = element(doc, "button", "", "Add server");
  add.type = "button";
  add.addEventListener("click", () => addRow({ kind: "stdio", name: "", command: "", args: [] }));
  const buttons = doc.createElement("div");
  buttons.className = "buttons";
  const save = element(doc, "button", "send", "Save");
  save.type = "button";
  save.addEventListener("click", () => {
    if (!canSave()) return;
    actions.writeMcp(rows.map(serverOf));
    dialog.close();
  });
  const cancel = element(doc, "button", "", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  buttons.append(save, cancel);
  form.append(add, buttons);
  dialog.replaceChildren(form);
  dialog.showModal();
}

// The MCP section of the page: its panel, which is rebuilt only when its state changes, and the dialog
// its editor opens in.
export interface McpSection {
  section: HTMLElement;
  dialog: HTMLDialogElement;
  update(info: McpInfo | undefined, sendable: boolean, canSave: () => boolean): void;
}

// A panel that folds. Its summary names the list and how many items it holds. A panel with more items than
// OPEN_LIMIT starts closed. After its first list, the reader's choice to open or close it is kept, so a
// re-render does not close it again.
const OPEN_LIMIT = 8;

export interface PanelBox {
  element: HTMLDetailsElement;
  show(title: string, count: number, nodes: Node[]): void;
}

export function panelBox(doc: Document): PanelBox {
  const details = doc.createElement("details");
  details.className = "sessions";
  const summary = doc.createElement("summary");
  const body = doc.createElement("div");
  details.append(summary, body);
  let started = false;
  return {
    element: details,
    show(title, count, nodes) {
      summary.textContent = `${title} (${count})`;
      // The heading the list builds is the summary now, so its own label is not shown twice.
      const items = nodes.filter(
        (node, index) => !(index === 0 && node instanceof HTMLElement && node.classList.contains("label")),
      );
      body.replaceChildren(...items);
      // The first render has empty lists, so only a list with items decides the starting state.
      if (!started && count > 0) {
        details.open = count <= OPEN_LIMIT;
        started = true;
      }
    },
  };
}

export function createMcpSection(doc: Document, actions: McpActions): McpSection {
  const box = panelBox(doc);
  const section = box.element;
  const dialog = doc.createElement("dialog");
  dialog.className = "profile-editor";
  let key = "";
  let current: McpInfo | undefined;
  return {
    section,
    dialog,
    update(info, sendable, canSave) {
      current = info;
      const next = JSON.stringify([info, sendable]);
      if (next === key) return;
      key = next;
      box.show("MCP servers", info?.servers.length ?? 0, mcpPanel(doc, info, sendable, () =>
        openMcpEditor(doc, { dialog, info: current, canSave, actions }),
      ));
    },
  };
}
