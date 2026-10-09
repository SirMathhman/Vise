/** One configured MCP server as the server describes it (`mcp` message). */
interface McpServer {
  name: string;
  scope: string;
  command: string;
  args: string[];
  env: Record<string, string>;
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

/** `KEY=value` lines to an object; throws a message for the user on a line without `=`. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf("=");
    if (at < 1) throw new Error(`env line needs NAME=value: ${line.trim()}`);
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return env;
}

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
  const command = make("input", "save-input");
  command.placeholder = "command, e.g. npx";
  command.autocomplete = "off";
  const args = make("textarea", "note-text");
  args.rows = 4;
  args.placeholder = "arguments, one per line";
  const env = make("textarea", "note-text");
  env.rows = 3;
  env.placeholder = "environment, one NAME=value per line (stored as plain text)";
  const disabledBox = make("input");
  disabledBox.type = "checkbox";
  const disabledLabel = make("label", "", " disabled");
  disabledLabel.prepend(disabledBox);
  const details = make("pre", "setting-hint");
  const hint = make("div", "setting-hint");
  hint.textContent =
    "Saving reconnects the server now. A conversation keeps the tools it started with; reload the page to give a new conversation the changed tools.";
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
  right.append(name, scope, command, args, env, disabledLabel, buttons, details, hint);
  const layout = make("div", "notes-layout");
  layout.append(left, right);
  body.append(layout);
  return {
    list,
    newBtn,
    name,
    scope,
    command,
    args,
    env,
    disabledBox,
    details,
    status,
    saveBtn,
    restartBtn,
    deleteBtn,
  };
}

/**
 * The "mcp" settings tab: the MCP servers configured for this folder (in its
 * `.viserc.json`) and for every project (`~/.vise/mcp.json`), with their live
 * state, and a form to add, change, disable, restart and delete them. The
 * server reads and writes the files and reconnects the changed servers
 * (`src/web/api/mcp-api.ts`). A conversation keeps the tools it started with;
 * new tools appear after a page reload.
 */
export function createMcpPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  /** Elements whose click means the tab may now be visible: refresh the list. */
  refreshOn: HTMLElement[],
): { handle(message: McpMessage): boolean } {
  let servers: McpServer[] = [];
  /** The server being edited, or null for a new one. */
  let current: Ref | null = null;

  const {
    list,
    newBtn,
    name,
    scope,
    command,
    args,
    env,
    disabledBox,
    details,
    status,
    saveBtn,
    restartBtn,
    deleteBtn,
  } = buildUi(body);

  const say = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };

  const find = (ref: Ref | null): McpServer | undefined =>
    servers.find((s) => s.name === ref?.name && s.scope === ref.scope);

  const showDetails = (): void => {
    details.textContent = detailsText(find(current));
  };

  const renderList = (): void =>
    renderServers(list, servers, current, edit);

  function edit(target: McpServer | null): void {
    current = target ? { name: target.name, scope: target.scope } : null;
    name.value = target?.name ?? "";
    scope.value = target?.scope ?? "project";
    command.value = target?.command ?? "";
    args.value = (target?.args ?? []).join("\n");
    env.value = Object.entries(target?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    disabledBox.checked = target?.disabled ?? false;
    restartBtn.disabled = target === null;
    deleteBtn.disabled = target === null;
    say("");
    showDetails();
    renderList();
    if (!target) name.focus();
  }

  newBtn.addEventListener("click", () => edit(null));
  saveBtn.addEventListener("click", () => {
    try {
      const entry = {
        name: name.value,
        scope: scope.value,
        command: command.value,
        args: lines(args.value),
        env: parseEnv(env.value),
        disabled: disabledBox.checked,
      };
      say("saving… (connecting to the server)");
      send({ type: "mcp_save", entry, ...(current ? { from: current } : {}) });
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    }
  });
  restartBtn.addEventListener("click", () => {
    if (!current) return;
    say("restarting…");
    send({ type: "mcp_restart", name: current.name });
  });
  deleteBtn.addEventListener("click", () => {
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
      if (message.saved) current = { name: name.value.trim(), scope: scope.value };
      const gone = current !== null && !message.saved && !find(current);
      if (gone) edit(null);
      renderList();
      showDetails();
      const problems = message.problems ?? [];
      if (message.error) say(message.error, true);
      else if (message.saved) say("saved");
      else if (problems.length > 0) say(problems.join("; "), true);
      else say("");
      return true;
    },
  };
}
