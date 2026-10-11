/** A file in the git status (its path is the repository's). */
interface GitFile {
  path: string;
  code: string;
}

/** The slice of a server message the git panel reacts to. */
export interface GitMessage {
  type: string;
  ok?: boolean;
  error?: string;
  repo?: boolean;
  prefix?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  staged?: GitFile[];
  changed?: GitFile[];
  untracked?: GitFile[];
  action?: string;
  output?: string;
}

const CODE_NAMES: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflict",
  T: "type changed",
  "?": "untracked",
};

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

/** What a file row can do. */
interface RowActions {
  send(msg: Record<string, unknown>): void;
  /** A repository path as a path under the session's folder, or null when it lies outside it. */
  inRoot(path: string): string | null;
  openFile(path: string): void;
}

/** One file: its path (opens it), its state letter, and a stage (+) or unstage (−) button. */
function fileRow(file: GitFile, verb: "Stage" | "Unstage", actions: RowActions): HTMLElement {
  const row = make("li", "list-row git-file");
  const local = actions.inRoot(file.path);
  const name = make("button", "git-path", file.path);
  name.type = "button";
  name.title = local === null ? file.path : `Open ${file.path}`;
  name.disabled = local === null || file.code === "D";
  name.addEventListener("click", () => {
    if (local !== null) actions.openFile(local);
  });
  // As editors show them: U for an untracked (new) file, ! for a conflict.
  const shown = file.code === "?" ? "U" : file.code === "U" ? "!" : file.code;
  const kind = file.code === "?" ? "new" : file.code === "U" ? "conflict" : file.code;
  const code = make("span", `git-code git-code--${kind}`, shown);
  code.title = CODE_NAMES[file.code] ?? file.code;
  const toggle = make("button", "btn btn--ghost btn--icon btn--sm", verb === "Stage" ? "+" : "−");
  toggle.type = "button";
  toggle.setAttribute("aria-label", `${verb} ${file.path}`);
  toggle.addEventListener("click", () =>
    actions.send({ type: verb === "Stage" ? "git_stage" : "git_unstage", paths: [file.path] }),
  );
  row.append(name, code, toggle);
  return row;
}

/** A group of files (staged, changed, untracked) with a button for all of them; nothing when empty. */
function fileGroup(
  label: string,
  files: GitFile[],
  verb: "Stage" | "Unstage",
  actions: RowActions,
): HTMLElement | null {
  if (files.length === 0) return null;
  const section = make("section", "git-group");
  const heading = make("div", "git-group-head");
  heading.append(make("span", "list-group-title", `${label} · ${files.length}`));
  const all = make("button", "btn btn--ghost btn--sm", `${verb} all`);
  all.type = "button";
  all.addEventListener("click", () =>
    actions.send({ type: verb === "Stage" ? "git_stage" : "git_unstage", paths: files.map((f) => f.path) }),
  );
  heading.append(all);
  const list = make("ul", "list git-files");
  for (const file of files) list.append(fileRow(file, verb, actions));
  section.append(heading, list);
  return section;
}

/** The panel's fixed parts: the branch and Refresh, the commit box, a status line, the file groups. */
function buildPanel(panel: HTMLElement) {
  const head = make("div", "dropdown-head");
  const title = make("strong", "git-branch", "Git");
  const reload = make("button", "btn btn--ghost btn--sm", "Refresh");
  reload.type = "button";
  head.append(title, reload);
  const message = make("textarea", "field git-message");
  message.rows = 2;
  message.placeholder = "Commit message";
  message.setAttribute("aria-label", "Commit message");
  const commit = make("button", "btn btn--primary", "Commit");
  commit.type = "button";
  const commitRow = make("div", "git-commit");
  commitRow.append(message, commit);
  const status = make("div", "status-line");
  status.setAttribute("role", "status");
  const body = make("div", "git-body");
  panel.append(head, commitRow, status, body);
  return { title, reload, message, commit, commitRow, status, body };
}

/**
 * The git panel (Agent → Git…): the branch, the staged, changed and untracked
 * files of the session's folder, staging and unstaging them, and a commit box.
 * It asks the server when it opens and after every turn (the agent may have
 * changed files); a file's name opens it in the workspace.
 */
export function createGitPanel(
  panel: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  openFile: (path: string) => void,
): { refresh(): void; handle(message: GitMessage): boolean } {
  const ui = buildPanel(panel);
  let stagedCount = 0;
  let prefix = "";
  const syncCommit = (): void => {
    ui.commit.disabled = stagedCount === 0 || ui.message.value.trim() === "";
  };
  const refresh = (): void => send({ type: "git_status" });
  ui.reload.addEventListener("click", refresh);
  ui.message.addEventListener("input", syncCommit);
  ui.commit.addEventListener("click", () => {
    ui.status.textContent = "Committing…";
    ui.status.classList.remove("error");
    send({ type: "git_commit", message: ui.message.value });
  });
  const actions: RowActions = {
    send,
    openFile,
    inRoot: (path) => {
      if (!prefix) return path;
      return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
    },
  };

  function render(state: GitMessage): void {
    ui.body.textContent = "";
    const empty = (text: string): void => void ui.body.append(make("p", "list-empty", text));
    if (!state.ok) return empty(state.error ?? "git failed");
    ui.commitRow.classList.toggle("hidden", !state.repo);
    if (!state.repo) {
      ui.title.textContent = "Git";
      return empty("This folder is not in a git repository.");
    }
    prefix = state.prefix ?? "";
    const counts = [state.ahead ? `↑${state.ahead}` : "", state.behind ? `↓${state.behind}` : ""].filter(Boolean).join(" ");
    ui.title.textContent = `⎇ ${state.branch ?? "detached"}${counts ? ` ${counts}` : ""}`;
    stagedCount = state.staged?.length ?? 0;
    syncCommit();
    const groups = [
      fileGroup("Staged", state.staged ?? [], "Unstage", actions),
      fileGroup("Changes", state.changed ?? [], "Stage", actions),
      fileGroup("Untracked", state.untracked ?? [], "Stage", actions),
    ].filter((group): group is HTMLElement => group !== null);
    if (groups.length === 0) empty("Working tree clean.");
    ui.body.append(...groups);
  }

  function result(msg: GitMessage): void {
    ui.status.classList.toggle("error", !msg.ok);
    if (!msg.ok) ui.status.textContent = msg.error ?? "git failed";
    else if (msg.action === "commit") {
      ui.status.textContent = msg.output?.split("\n")[0] ?? "Committed.";
      ui.message.value = "";
      syncCommit();
    } else ui.status.textContent = "";
  }

  return {
    refresh,
    handle(msg) {
      if (msg.type === "git_status") render(msg);
      else if (msg.type === "git_result") result(msg);
      else return false;
      return true;
    },
  };
}
