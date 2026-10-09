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

/** Lines of `name<separator>value` to an object; throws a message for the user on a line without the separator. */
function parsePairs(
  text: string,
  separator: string,
  example: string,
): Record<string, string> {
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

const lines = (text: string): string[] =>
  text.split("\n").filter((l) => l.trim() !== "");

/** The label of a list entry: its name and how it is doing. */
function describe(server: McpServer): string {
  if (server.shadowed) return `${server.name} · replaced by the project server`;
  const count = server.state === "ready" ? ` (${server.tools} tools)` : "";
  return `${server.name} · ${server.state}${count}`;
}

/** What a server is doing: its state, why it is not working, what it printed. */
function detailsText(server: McpServer | undefined): string {
  if (!server) return "";
  return [describe(server), server.reason, server.stderr]
    .filter(Boolean)
    .join("\n");
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
      list.append(make("li", "note-group", server.scope));
    }
    const item = make("li");
    const button = make("button", "note-item", describe(server));
    const selected = current?.name === server.name && current.scope === server.scope;
    button.setAttribute("aria-current", String(selected));
    button.addEventListener("click", () => open(server));
    item.append(button);
    list.append(item);
  }
  if (servers.length === 0) list.append(make("li", "note-group", "no servers yet"));
}

/** The panel's elements: the server list on the left, the form on the right (already added to `body`). */
function buildUi(body: HTMLElement) {
  const list = make("ul", "tools-list");
  const newBtn = make("button", "tools-btn", "+ new server");
  const name = make("input", "save-input");
  name.placeholder = "name";
  name.autocomplete = "off";
  const scope = make("select", "save-input");
  scope.append(new Option("project (this folder only)", "project"));
  scope.append(new Option("global (every project)", "global"));
  scope.setAttribute("aria-label", "scope");
  const kind = make("select", "save-input");
  kind.append(new Option("local program (stdio)", "stdio"));
  kind.append(new Option("remote server (URL)", "url"));
  kind.setAttribute("aria-label", "type");
  const command = make("input", "save-input");
  command.placeholder = "command, e.g. npx";
  command.autocomplete = "off";
  const args = make("textarea", "note-text");
  args.rows = 4;
  args.placeholder = "arguments, one per line";
  const env = make("textarea", "note-text");
  env.rows = 3;
  env.placeholder = "environment, one NAME=value per line (stored as plain text)";
  const url = make("input", "save-input");
  url.placeholder = "https://example.com/mcp";
  url.autocomplete = "off";
  const headers = make("textarea", "note-text");
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
  const details = make("pre", "setting-hint");
  const hint = make("div", "setting-hint");
  hint.textContent =
    "Saving reconnects the server now and reloads the page, so the conversation gets the changed tools (your chat comes back).";
  const status = make("span", "pe-status");
  status.setAttribute("role", "status");
  const saveBtn = make("button", "save-btn", "save");
  const restartBtn = make("button", "tools-btn", "restart");
  const deleteBtn = make("button", "tools-btn", "delete");
  const buttons = make("div", "save-row");
  buttons.append(saveBtn, restartBtn, deleteBtn, status);

  const left = make("div", "notes-side");
  left.append(newBtn, list);
  const right = make("div", "notes-edit");
  right.append(name, scope, kind, ...local, ...remote, disabledLabel, buttons, details, hint);
  const layout = make("div", "notes-layout");
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
 * Reload the page so its conversation is built with the changed tools (a
 * conversation keeps the tool list it started with; the saved chat comes back
 * on reload). A turn in progress is never interrupted: wait until it ends.
 */
function reloadWhenIdle(isBusy: () => boolean, say: (text: string) => void): void {
  if (isBusy()) {
    say("saved. The page reloads when the current turn ends, to load the changed tools.");
    setTimeout(() => reloadWhenIdle(isBusy, say), 500);
    return;
  }
  say("saved. Reloading to load the changed tools…");
  window.location.reload();
}

/**
 * The "mcp" settings tab: the MCP servers configured for this folder (in its
 * `.viserc.json`) and for every project (`~/.vise/mcp.json`), local programs
 * and remote URLs alike, with their live state, and a form to add, change,
 * disable, restart and delete them. The server reads and writes the files and
 * reconnects the changed servers (`src/web/api/mcp-api.ts`). A conversation
 * keeps the tools it started with, so the page reloads itself after a save or
 * a delete.
 */
export function createMcpPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  /** Elements whose click means the tab may now be visible: refresh the list. */
  refreshOn: HTMLElement[],
  /** Whether a turn is running (the reload waits for it to end). */
  isBusy: () => boolean,
): { handle(message: McpMessage): boolean } {
  let servers: McpServer[] = [];
  /** The server being edited, or null for a new one. */
  let current: Ref | null = null;
  const ui = buildUi(body);

  const say = (message: string, error = false): void => {
    ui.status.textContent = message;
    ui.status.classList.toggle("error", error);
  };

  const find = (ref: Ref | null): McpServer | undefined =>
    servers.find((s) => s.name === ref?.name && s.scope === ref.scope);

  const showDetails = (): void => {
    ui.details.textContent = detailsText(find(current));
  };

  const renderList = (): void =>
    renderServers(ui.list, servers, current, edit);

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
      say("saving… (connecting to the server)");
      send({ type: "mcp_save", entry, ...(current ? { from: current } : {}) });
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    }
  });
  ui.restartBtn.addEventListener("click", () => {
    if (!current) return;
    say("restarting…");
    send({ type: "mcp_restart", name: current.name });
  });
  ui.deleteBtn.addEventListener("click", () => {
    if (!current || !confirm(`Delete MCP server '${current.name}'?`)) return;
    say("deleting…");
    send({ type: "mcp_delete", ...current });
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
      else if (message.saved || message.deleted) reloadWhenIdle(isBusy, say);
      else if (problems.length > 0) say(problems.join("; "), true);
      else say("");
      return true;
    },
  };
}
