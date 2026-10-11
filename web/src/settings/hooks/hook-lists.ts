import { confirmAction } from "../../feedback/confirm.ts";

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
    heading.className = "list-group-title";
    heading.textContent = labels[phase];
    container.appendChild(heading);
    const list = document.createElement("ul");
    list.className = "list";
    if (hooks[phase].length === 0) {
      const empty = list.appendChild(document.createElement("li"));
      empty.className = "list-empty";
      empty.textContent = "None";
    }
    hooks[phase].forEach((command, i) => {
      const item = document.createElement("li");
      item.className = "list-row";
      const text = document.createElement("code");
      text.textContent = command;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove hook ${command}`);
      remove.addEventListener("click", () => {
        void confirmAction({
          title: "Remove this hook?",
          message: command,
          confirmLabel: "Remove",
        }).then((yes) => {
          if (yes) edit(`${prefix} remove ${phase} ${i + 1}`);
        });
      });
      item.append(text, remove);
      list.appendChild(item);
    });
    container.append(list, addRow(phase, prefix, edit));
  }
}

function addRow(phase: Phase, prefix: string, edit: Edit): HTMLElement {
  const row = document.createElement("div");
  row.className = "actions";
  const input = document.createElement("input");
  input.className = "field field--mono";
  input.type = "text";
  input.placeholder = `Add a ${phase}-turn hook command…`;
  input.setAttribute("aria-label", `New ${phase}-turn hook command`);
  input.autocomplete = "off";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn";
  add.textContent = "Add";
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
