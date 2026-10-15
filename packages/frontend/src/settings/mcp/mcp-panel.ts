import { ifConfirmed } from "../../feedback/confirm.ts";
import { make } from "../../dom.ts";

/** One configured MCP server as the server describes it (`mcp` message). A local one has a `command`, a remote one a `url`. */
interface McpServer {
  name: string;
  scope: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled: boolean;
  /** A global server that a project server of the same name replaces. */
  shadowed: boolean;
  state: string;
  reason?: string;
  tools: number;
  stderr: string;
}

/** The slice of a server message the MCP panel reacts to. */
export interface McpMessage {
  type: string;
  servers?: McpServer[];
  problems?: string[];
  saved?: boolean;
  deleted?: boolean;
  error?: string;
}

type Ref = { name: string; scope: string };

/** Lines of `name<separator>value` to an object; throws a message for the user on a line without the separator. */
function parsePairs(text: string, separator: string, example: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf(separator);
    if (at < 1) throw new Error(`each line needs ${example}: ${line.trim()}`);
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return pairs;
}

const showPairs = (pairs: Record<string, string> | undefined, separator: string): string =>
  Object.entries(pairs ?? {})
    .map(([k, v]) => `${k}${separator}${v}`)
    .join("\n");

const lines = (text: string): string[] => text.split("\n").filter((l) => l.trim() !== "");

/** The label of a list entry: its name and how it is doing. */
function describe(server: McpServer): string {
  if (server.shadowed) return `${server.name} · replaced by the project server`;
  const count = server.state === "ready" ? ` (${server.tools} tools)` : "";
  return `${server.name} · ${server.state}${count}`;
}

/** What a server is doing: its state, why it is not working, what it printed. */
function detailsText(server: McpServer | undefined): string {
  if (!server) return "";
  return [describe(server), server.reason, server.stderr].filter(Boolean).join("\n");
}

/** Fill the server list, grouped under scope headings; clicking an entry opens it in the form. */
function renderServers(
  list: HTMLElement,
  servers: McpServer[],
  current: Ref | null,
  open: (server: McpServer) => void,
): void {
  list.textContent = "";
  let last = "";
  for (const server of servers) {
    if (server.scope !== last) {
      last = server.scope;
      list.append(make("li", "list-group-title", server.scope));
    }
    const item = make("li");
    const button = make("button", "list-item", describe(server));
    const selected = current?.name === server.name && current.scope === server.scope;
    button.setAttribute("aria-current", String(selected));
    button.addEventListener("click", () => open(server));
    item.append(button);
    list.append(item);
  }
  if (servers.length === 0) list.append(make("li", "list-empty", "No servers yet."));
}

/** The panel's elements: the server list on the left, the form on the right (already added to `body`). */
function buildUi(body: HTMLElement) {
  const list = make("ul", "list");
  const newBtn = make("button", "btn", "+ New server");
  const name = make("input", "field");
  name.placeholder = "Name";
  name.autocomplete = "off";
  const scope = make("select", "field");
  scope.append(new Option("Project (this folder only)", "project"));
  scope.append(new Option("Global (every folder)", "global"));
  scope.setAttribute("aria-label", "scope");
  const kind = make("select", "field");
  kind.append(new Option("Local program (stdio)", "stdio"));
  kind.append(new Option("Remote server (URL)", "url"));
  kind.setAttribute("aria-label", "type");
  const command = make("input", "field");
  command.placeholder = "Command, e.g. npx";
  command.autocomplete = "off";
  const args = make("textarea", "field");
  args.rows = 4;
  args.placeholder = "Arguments, one per line";
  const env = make("textarea", "field");
  env.rows = 3;
  env.placeholder = "Environment, one NAME=value per line (stored as plain text)";
  const url = make("input", "field");
  url.placeholder = "https://example.com/mcp";
  url.autocomplete = "off";
  const headers = make("textarea", "field");
  headers.rows = 3;
  headers.placeholder =
    "headers, one Name: value per line, e.g. Authorization: Bearer … (stored as plain text)";
  const local = [command, args, env];
  const remote = [url, headers];
  const showKind = (): void => {
    for (const f of local) f.classList.toggle("hidden", kind.value !== "stdio");
    for (const f of remote) f.classList.toggle("hidden", kind.value !== "url");
  };
  kind.addEventListener("change", showKind);
  const disabledBox = make("input");
  disabledBox.type = "checkbox";
  const disabledLabel = make("label", "", " disabled");
  disabledLabel.prepend(disabledBox);
  const details = make("pre", "hint");
  const hint = make("div", "hint");
  hint.textContent =
    "Saving reconnects the server now and reloads the page, so the conversation gets the changed tools (your chat comes back).";
  const status = make("span", "status-line");
  status.setAttribute("role", "status");
  const saveBtn = make("button", "btn btn--primary", "Save");
  const restartBtn = make("button", "btn", "Restart");
  const deleteBtn = make("button", "btn btn--danger", "Delete");
  const buttons = make("div", "actions");
  buttons.append(saveBtn, restartBtn, deleteBtn, status);

  const left = make("div", "two-pane__side");
  left.append(newBtn, list);
  const right = make("div", "two-pane__main");
  right.append(name, scope, kind, ...local, ...remote, disabledLabel, buttons, details, hint);
  const layout = make("div", "two-pane");
  layout.append(left, right);
  body.append(layout);
  showKind();
  return {
    list,
    newBtn,
    name,
    scope,
    kind,
    command,
    args,
    env,
    url,
    headers,
    disabledBox,
    details,
    status,
    saveBtn,
    restartBtn,
    deleteBtn,
    showKind,
  };
}

type Ui = ReturnType<typeof buildUi>;

/** Put a server (or nothing, for a new one) into the form. */
function fillForm(ui: Ui, target: McpServer | null): void {
  ui.name.value = target?.name ?? "";
  ui.scope.value = target?.scope ?? "project";
  ui.kind.value = target?.url !== undefined ? "url" : "stdio";
  ui.command.value = target?.command ?? "";
  ui.args.value = (target?.args ?? []).join("\n");
  ui.env.value = showPairs(target?.env, "=");
  ui.url.value = target?.url ?? "";
  ui.headers.value = showPairs(target?.headers, ": ");
  ui.disabledBox.checked = target?.disabled ?? false;
  ui.showKind();
}

/** The form as the entry the server saves; throws a message for the user when a line is malformed. */
function readEntry(ui: Ui): Record<string, unknown> {
  const common = {
    name: ui.name.value,
    scope: ui.scope.value,
    disabled: ui.disabledBox.checked,
  };
  if (ui.kind.value === "url") {
    return {
      ...common,
      url: ui.url.value.trim(),
      headers: parsePairs(ui.headers.value, ":", "Name: value"),
    };
  }
  return {
    ...common,
    command: ui.command.value,
    args: lines(ui.args.value),
    env: parsePairs(ui.env.value, "=", "NAME=value"),
  };
}

/**
 * Offer to reload the page so its conversation is built with the changed tools
 * (a conversation keeps the tool list it started with; the saved chat comes
 * back on reload). Nothing reloads by itself: the user may be in the middle of
 * something, and a turn in progress must finish first.
 */
function offerReload(isBusy: () => boolean, box: HTMLElement): void {
  box.textContent = "";
  box.classList.remove("hidden");
  const text = document.createElement("span");
  text.textContent = "Saved. Reload the page to give this conversation the changed tools.";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "btn btn--primary btn--sm";
  reload.textContent = "Reload now";
  reload.addEventListener("click", () => {
    if (isBusy()) {
      text.textContent = "A turn is running: reload when it ends.";
      return;
    }
    window.location.reload();
  });
  box.append(text, reload);
}

/**
 * The "mcp" settings tab: the MCP servers configured for this folder (in its
 * `.viserc.json`) and for every project (`~/.vise/mcp.json`), local programs
 * and remote URLs alike, with their live state, and a form to add, change,
 * disable, restart and delete them. The server reads and writes the files and
 * reconnects the changed servers (`src/web/api/mcp-api.ts`). A conversation
 * keeps the tools it started with, so after a save or a delete the page offers
 * to reload.
 */
export function createMcpPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  /** Elements whose click means the tab may now be visible: refresh the list. */
  refreshOn: HTMLElement[],
  /** Whether a turn is running (a reload must wait for it to end). */
  isBusy: () => boolean,
): { handle(message: McpMessage): boolean } {
  let servers: McpServer[] = [];
  /** The server being edited, or null for a new one. */
  let current: Ref | null = null;
  const ui = buildUi(body);
  /** The offer to reload after a change (shown above the form). */
  const notice = document.createElement("div");
  notice.className = "notice hidden";
  notice.setAttribute("role", "status");
  body.prepend(notice);

  const say = (message: string, error = false): void => {
    ui.status.textContent = message;
    ui.status.classList.toggle("error", error);
  };

  const find = (ref: Ref | null): McpServer | undefined =>
    servers.find((s) => s.name === ref?.name && s.scope === ref.scope);

  const showDetails = (): void => {
    ui.details.textContent = detailsText(find(current));
  };

  const renderList = (): void => renderServers(ui.list, servers, current, edit);

  function edit(target: McpServer | null): void {
    current = target ? { name: target.name, scope: target.scope } : null;
    fillForm(ui, target);
    ui.restartBtn.disabled = target === null;
    ui.deleteBtn.disabled = target === null;
    say("");
    showDetails();
    renderList();
    if (!target) ui.name.focus();
  }

  ui.newBtn.addEventListener("click", () => edit(null));
  ui.saveBtn.addEventListener("click", () => {
    try {
      const entry = readEntry(ui);
      say("Saving… (connecting to the server)");
      send({ type: "mcp_save", entry, ...(current ? { from: current } : {}) });
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    }
  });
  ui.restartBtn.addEventListener("click", () => {
    if (!current) return;
    say("Restarting…");
    send({ type: "mcp_restart", name: current.name });
  });
  ui.deleteBtn.addEventListener("click", () => {
    const target = current;
    if (!target) return;
    const title = `Delete the MCP server “${target.name}”?`;
    const message = "Its entry is removed from the settings file and the server is stopped.";
    ifConfirmed({ title, message }, () => {
      say("Deleting…");
      send({ type: "mcp_delete", ...target });
    });
  });
  for (const trigger of refreshOn) {
    trigger.addEventListener("click", () => send({ type: "mcp_get" }));
  }
  edit(null);

  return {
    handle(message) {
      if (message.type !== "mcp") return false;
      servers = message.servers ?? [];
      // After a save the server is the one being edited (a rename or a move changed its reference).
      if (message.saved) {
        current = { name: ui.name.value.trim(), scope: ui.scope.value };
      }
      const gone = current !== null && !message.saved && !find(current);
      if (gone) edit(null);
      renderList();
      showDetails();
      const problems = message.problems ?? [];
      if (message.error) say(message.error, true);
      else if (message.saved || message.deleted) offerReload(isBusy, notice);
      else if (problems.length > 0) say(problems.join("; "), true);
      else say("");
      return true;
    },
  };
}
