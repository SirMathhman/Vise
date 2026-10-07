type Phase = "pre" | "post";

/** Hook commands by phase. */
export interface HookCommands {
  pre: string[];
  post: string[];
}

/** Sends a `/hooks ...` line to the server. */
export type Edit = (line: string) => void;

/**
 * Render the pre- and post-turn hook lists with a remove button per hook and
 * an "add" row per phase. Used for the global hooks (`prefix` = `/hooks`) and
 * for a profile's own hooks (`prefix` = `/hooks profile <name>`); both forms
 * take `add|remove pre|post ...` after the prefix, so the same lists drive
 * either one.
 */
export function renderHookLists(
  container: HTMLElement,
  hooks: HookCommands,
  prefix: string,
  labels: Record<Phase, string>,
  edit: Edit,
): void {
  for (const phase of ["pre", "post"] as const) {
    const heading = document.createElement("div");
    heading.className = "files-path";
    heading.textContent = labels[phase];
    container.appendChild(heading);
    const list = document.createElement("ul");
    list.className = "tools-list";
    if (hooks[phase].length === 0) {
      list.appendChild(document.createElement("li")).textContent = "none";
    }
    hooks[phase].forEach((command, i) => {
      const item = document.createElement("li");
      item.className = "session-row"; // reveals the × on hover
      const text = document.createElement("code");
      text.textContent = `${i + 1}. ${command}`;
      const remove = document.createElement("button");
      remove.className = "session-delete";
      remove.textContent = "×";
      remove.title = `remove hook ${i + 1}`;
      remove.addEventListener("click", () =>
        edit(`${prefix} remove ${phase} ${i + 1}`),
      );
      item.append(text, remove);
      list.appendChild(item);
    });
    container.append(list, addRow(phase, prefix, edit));
  }
}

function addRow(phase: Phase, prefix: string, edit: Edit): HTMLElement {
  const row = document.createElement("div");
  row.className = "save-row";
  const input = document.createElement("input");
  input.className = "save-input";
  input.type = "text";
  input.placeholder = `add a ${phase}-turn hook command…`;
  input.autocomplete = "off";
  const add = document.createElement("button");
  add.className = "save-btn";
  add.textContent = "add";
  const submit = (): void => {
    const command = input.value.trim();
    if (!command) return;
    // The terminal form quotes the command; escape any quotes inside it.
    edit(`${prefix} add ${phase} "${command.replaceAll('"', '\\"')}"`);
    input.value = "";
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  row.append(input, add);
  return row;
}
