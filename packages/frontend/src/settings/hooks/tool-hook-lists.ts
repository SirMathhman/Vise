import { describeToolHook, type ToolHookEntry } from "@vise/core";
import { confirmAction } from "../../feedback/confirm.ts";
import type { Edit } from "./hook-lists.ts";

type ToolPhase = "pretool" | "posttool";

/** The global tool hooks, by phase. */
export interface ToolHookLists {
  preTool: ToolHookEntry[];
  postTool: ToolHookEntry[];
}

const LABELS: Record<ToolPhase, string> = {
  pretool: "Pre-tool hooks · run before a tool call; exit code 2 blocks it",
  posttool: "Post-tool hooks · run after a tool call; output joins its result",
};

/**
 * The pre- and post-tool hook lists (global only): a remove button per hook
 * and an "add" row with an optional comma-separated tool/category filter.
 * Edits go back as `/hooks add|remove pretool|posttool ...` lines.
 */
export function renderToolHookLists(
  container: HTMLElement,
  hooks: ToolHookLists,
  edit: Edit,
): void {
  for (const phase of ["pretool", "posttool"] as const) {
    const entries = phase === "pretool" ? hooks.preTool : hooks.postTool;
    const heading = document.createElement("div");
    heading.className = "list-group-title";
    heading.textContent = LABELS[phase];
    container.appendChild(heading);
    const list = document.createElement("ul");
    list.className = "list";
    if (entries.length === 0) {
      const empty = list.appendChild(document.createElement("li"));
      empty.className = "list-empty";
      empty.textContent = "None";
    }
    entries.forEach((entry, i) => {
      const item = document.createElement("li");
      item.className = "list-row";
      const text = document.createElement("code");
      text.textContent = describeToolHook(entry);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove tool hook ${entry.command}`);
      remove.addEventListener("click", () => {
        void confirmAction({
          title: "Remove this hook?",
          message: entry.command,
          confirmLabel: "Remove",
        }).then((yes) => {
          if (yes) edit(`/hooks remove ${phase} ${i + 1}`);
        });
      });
      item.append(text, remove);
      list.appendChild(item);
    });
    container.append(list, addRow(phase, edit));
  }
}

function addRow(phase: ToolPhase, edit: Edit): HTMLElement {
  const row = document.createElement("div");
  row.className = "actions";
  const input = document.createElement("input");
  input.className = "field field--mono";
  input.type = "text";
  input.placeholder = `Add a ${phase === "pretool" ? "pre" : "post"}-tool hook command…`;
  input.setAttribute("aria-label", `New ${phase} hook command`);
  input.autocomplete = "off";
  const tools = document.createElement("input");
  tools.className = "field field--mono";
  tools.type = "text";
  tools.placeholder = "Tools or categories (optional, comma-separated)";
  tools.setAttribute("aria-label", `Tools the ${phase} hook applies to`);
  tools.autocomplete = "off";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn";
  add.textContent = "Add";
  const submit = (): void => {
    const command = input.value.trim();
    if (!command) return;
    const filter = tools.value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const quoted = `"${command.replaceAll('"', '\\"')}"`;
    edit(`/hooks add ${phase} ${quoted}${filter.length > 0 ? ` --tools ${filter.join(",")}` : ""}`);
    input.value = "";
    tools.value = "";
  };
  add.addEventListener("click", submit);
  for (const field of [input, tools]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }
  row.append(input, tools, add);
  return row;
}
