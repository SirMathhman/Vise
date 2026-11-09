import type { McpServerEntry, McpServerStatus } from "../../protocol/protocol.ts";
import type { McpInfo } from "./state.ts";

// What the MCP section asks the page to do: save the servers the editor shows.
export interface McpActions {
  writeMcp(servers: McpServerEntry[]): void;
}

// One server row of the editor: its name, its command, and its arguments, one per line.
interface ServerRow {
  element: HTMLElement;
  name: HTMLInputElement;
  command: HTMLInputElement;
  args: HTMLTextAreaElement;
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

// One row of the editor, filled from a server or empty.
function rowOf(doc: Document, server: McpServerEntry, remove: (row: ServerRow) => void): ServerRow {
  const row = doc.createElement("div");
  row.className = "server-row";
  const name = doc.createElement("input");
  name.type = "text";
  name.value = server.name;
  name.placeholder = "name";
  const command = doc.createElement("input");
  command.type = "text";
  command.value = server.command;
  command.placeholder = "command";
  const args = doc.createElement("textarea");
  args.rows = 2;
  args.value = server.args.join("\n");
  args.placeholder = "one argument per line";
  const removeButton = element(doc, "button", "", "Remove");
  removeButton.type = "button";
  const entry: ServerRow = { element: row, name, command, args };
  removeButton.addEventListener("click", () => remove(entry));
  row.append(name, command, args, removeButton);
  return entry;
}

// Reads a row back into a server. Blank argument lines are dropped.
function serverOf(row: ServerRow): McpServerEntry {
  return {
    name: row.name.value.trim(),
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
  add.addEventListener("click", () => addRow({ name: "", command: "", args: [] }));
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

export function createMcpSection(doc: Document, actions: McpActions): McpSection {
  const section = doc.createElement("section");
  section.className = "sessions";
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
      section.replaceChildren(
        ...mcpPanel(doc, info, sendable, () =>
          openMcpEditor(doc, { dialog, info: current, canSave, actions }),
        ),
      );
    },
  };
}
