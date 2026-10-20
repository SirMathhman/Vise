type Step =
  | { type: "instruction"; text: string }
  | { type: "profile"; name: string }
  | {
      type: "tool";
      name: string;
      args: Record<string, unknown>;
      exact?: boolean;
    };

interface WorkflowEntry {
  name: string;
  scope: string;
  active: boolean;
}

/** The slice of a server message the workflows panel reacts to. */
export interface WorkflowsMessage {
  type: string;
  workflows?: WorkflowEntry[];
  name?: string;
  scope?: string;
  steps?: Step[];
  toolDefs?: ToolInfo[];
  profiles?: string[];
  ok?: boolean;
  deleted?: boolean;
  error?: string;
}

import { createArgRows, type ToolInfo } from "./arg-rows.ts";
import { ifConfirmed } from "../../feedback/confirm.ts";
import { make } from "../../dom.ts";

type Ref = { name: string; scope: string };

/** One editable step row; `read()` returns the step or throws a message for the user. */
function stepRow(
  step: Step,
  tools: () => ToolInfo[],
  profiles: () => string[],
  move: (by: number) => void,
  drop: () => void,
) {
  const row = make("div", "wf-step");
  const kind = make("select", "field");
  kind.append(new Option("Instruction", "instruction"));
  kind.append(new Option("Tool call", "tool"));
  kind.append(new Option("Switch profile", "profile"));
  kind.value = step.type;
  const text = make("textarea", "field");
  text.rows = 3;
  text.placeholder = "{{input}} is replaced by the workflow's input";
  const toolName = make("select", "field");
  toolName.setAttribute("aria-label", "tool");
  const profileName = make("select", "field");
  profileName.setAttribute("aria-label", "profile");
  const savedProfile = step.type === "profile" ? step.name : "";
  // A profile the list does not know (the list may not have arrived) stays selectable.
  const fillProfiles = (selected: string): void => {
    const names = profiles();
    profileName.textContent = "";
    const choices = selected && !names.includes(selected) ? [selected, ...names] : names;
    for (const name of choices) profileName.append(new Option(name, name));
    profileName.value = selected || profileName.options[0]?.value || "";
  };
  fillProfiles(savedProfile);
  const argsBox = make("div", "wf-args");
  let saved = step.type === "tool" ? step : undefined;
  // A tool the list does not know (the list may not have arrived) stays selectable.
  const fillTools = (selected: string): void => {
    const names = tools().map((t) => t.name);
    toolName.textContent = "";
    const choices = selected && !names.includes(selected) ? [selected, ...names] : names;
    for (const name of choices) toolName.append(new Option(name, name));
    toolName.value = selected || toolName.options[0]?.value || "";
  };
  const argsFor = (): ReturnType<typeof createArgRows> => {
    const from = saved?.name === toolName.value ? saved : undefined;
    return createArgRows(
      argsBox,
      tools().find((t) => t.name === toolName.value)?.params ?? [],
      from?.args ?? {},
      from?.exact === true,
    );
  };
  fillTools(saved?.name ?? "");
  let argRows = argsFor();
  toolName.addEventListener("change", () => {
    argRows = argsFor();
  });
  if (step.type === "instruction") text.value = step.text;
  const show = (): void => {
    const isTool = kind.value === "tool";
    text.hidden = kind.value !== "instruction";
    toolName.hidden = !isTool;
    argsBox.hidden = !isTool;
    profileName.hidden = kind.value !== "profile";
  };
  kind.addEventListener("change", show);
  show();
  const bar = make("div", "actions");
  for (const [label, action] of [
    ["↑", () => move(-1)],
    ["↓", () => move(1)],
    ["✕", drop],
  ] as const) {
    const button = make("button", "btn", label);
    button.type = "button";
    button.addEventListener("click", action);
    bar.append(button);
  }
  row.append(kind, text, profileName, toolName, argsBox, bar);
  const read = (): Step => {
    if (kind.value === "instruction") {
      return { type: "instruction", text: text.value };
    }
    if (kind.value === "profile") return { type: "profile", name: profileName.value };
    return {
      type: "tool",
      name: toolName.value,
      args: argRows.read(),
      exact: true,
    };
  };
  /** The tool list arrived or changed: refill the choices, keeping what is chosen and entered. */
  const refreshTools = (): void => {
    const chosen = toolName.value;
    if (kind.value === "tool" && chosen) {
      saved = { type: "tool", name: chosen, args: argRows.read(), exact: true };
    }
    fillTools(chosen);
    argRows = argsFor();
    fillProfiles(profileName.value);
  };
  return { row, read, refreshTools };
}

const isRef = (ref: Ref | null, message: Partial<Ref>): boolean =>
  ref !== null && ref.name === message.name && ref.scope === message.scope;

/** Fill the workflow list; clicking an entry opens it. */
function renderList(
  list: HTMLElement,
  entries: WorkflowEntry[],
  current: Ref | null,
  open: (target: Ref) => void,
): void {
  list.textContent = "";
  for (const entry of entries) {
    const item = make("li");
    const label = entry.active ? entry.name : `${entry.name} (shadowed)`;
    const button = make("button", "list-item", `${entry.scope} · ${label}`);
    button.setAttribute("aria-current", String(isRef(current, entry)));
    button.addEventListener("click", () => open(entry));
    item.append(button);
    list.append(item);
  }
  if (entries.length === 0) {
    list.append(make("li", "list-empty", "No workflows yet."));
  }
}

/** The ordered, editable step rows inside `box`. */
function createStepList(box: HTMLElement, tools: () => ToolInfo[], profiles: () => string[]) {
  let rows: ReturnType<typeof stepRow>[] = [];
  function add(step: Step): void {
    const index = (): number => rows.indexOf(entry);
    const entry = stepRow(
      step,
      tools,
      profiles,
      (by) => {
        const from = index();
        const to = from + by;
        if (to < 0 || to >= rows.length) return;
        const moved = rows.splice(from, 1)[0];
        if (moved) rows.splice(to, 0, moved);
        box.replaceChildren(...rows.map((r) => r.row));
      },
      () => {
        rows.splice(index(), 1);
        entry.row.remove();
      },
    );
    rows.push(entry);
    box.append(entry.row);
  }
  return {
    add,
    show(steps: Step[]): void {
      rows = [];
      box.textContent = "";
      for (const step of steps) add(step);
    },
    read: (): Step[] => rows.map((r) => r.read()),
    refreshTools: (): void => rows.forEach((r) => r.refreshTools()),
  };
}

/** The panel's elements: the workflow list on the left, the editor on the right. */
function buildUi() {
  const list = make("ul", "list");
  const name = make("input", "field");
  name.placeholder = "Name";
  name.autocomplete = "off";
  const scope = make("select", "field");
  scope.append(new Option("Project (this folder only)", "project"));
  scope.append(new Option("Global (every folder)", "global"));
  scope.setAttribute("aria-label", "scope");
  const stepsBox = make("div", "wf-steps");
  const addBtn = make("button", "btn", "+ Add step");
  const saveBtn = make("button", "btn btn--primary", "Save");
  const deleteBtn = make("button", "btn btn--danger", "Delete");
  const newBtn = make("button", "btn", "+ New workflow");
  const status = make("span", "status-line");
  status.setAttribute("role", "status");
  const buttons = make("div", "actions");
  buttons.append(saveBtn, deleteBtn, status);
  const left = make("div", "two-pane__side");
  left.append(newBtn, list);
  const right = make("div", "two-pane__main");
  right.append(name, scope, stepsBox, addBtn, buttons);
  const layout = make("div", "two-pane");
  layout.append(left, right);
  return {
    layout,
    list,
    name,
    scope,
    stepsBox,
    addBtn,
    saveBtn,
    deleteBtn,
    newBtn,
    status,
  };
}

/** Each click on a trigger asks again for the list and the tools (the first request may have gone out before the connection opened). */
function refreshOnClick(
  refreshOn: HTMLElement[],
  send: (msg: Record<string, unknown>) => void,
): void {
  for (const trigger of refreshOn) {
    trigger.addEventListener("click", () => {
      send({ type: "workflows_list" });
      send({ type: "workflow_tools" });
    });
  }
}

/** Ask, then delete the workflow being edited (nothing when none is). */
function confirmDelete(target: Ref | null, send: (msg: Record<string, unknown>) => void): void {
  if (!target) return;
  ifConfirmed({ title: `Delete the workflow “${target.name}”?` }, () =>
    send({ type: "workflow_delete", ...target }),
  );
}

/**
 * The "workflows" settings tab: the project's and global workflows, and a step
 * list editor (instruction or tool-call rows, reorderable) to create, edit and
 * delete them. The server reads and writes the workflow files directly
 * (`src/web/api/workflows-api.ts`), the same ones `/workflow` runs. A workflow's
 * name and scope are fixed once it is created.
 */
export function createWorkflowsPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  /** Elements whose click means the tab may now be visible: refresh the list. */
  refreshOn: HTMLElement[],
): { handle(message: WorkflowsMessage): boolean } {
  let current: Ref | null = null;
  let entries: WorkflowEntry[] = [],
    profileNames: string[] = [],
    toolInfos: ToolInfo[] = [];
  const ui = buildUi();
  const { list, name, scope, saveBtn, deleteBtn, status } = ui;
  const steps = createStepList(
    ui.stepsBox,
    () => toolInfos,
    () => profileNames,
  );

  const say = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };

  const renderAll = (): void => renderList(list, entries, current, edit);

  function edit(target: Ref | null): void {
    current = target ? { name: target.name, scope: target.scope } : null;
    name.value = target?.name ?? "";
    scope.value = target?.scope ?? "project";
    name.disabled = scope.disabled = target !== null;
    deleteBtn.disabled = target === null;
    saveBtn.disabled = target !== null; // until its steps have arrived
    say("");
    steps.show(target ? [] : [{ type: "instruction", text: "" }]);
    renderAll();
    if (current) send({ type: "workflow_get", ...current });
    else name.focus();
  }

  ui.newBtn.addEventListener("click", () => edit(null));
  ui.addBtn.addEventListener("click", () => steps.add({ type: "instruction", text: "" }));
  saveBtn.addEventListener("click", () => {
    try {
      const read = steps.read();
      say("Saving…");
      send({
        type: "workflow_save",
        name: name.value,
        scope: scope.value,
        steps: read,
        replace: current !== null,
      });
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  });
  deleteBtn.addEventListener("click", () => confirmDelete(current, send));
  refreshOnClick(refreshOn, send);

  send({ type: "workflow_tools" });
  body.append(ui.layout);
  edit(null);

  return {
    handle(message) {
      switch (message.type) {
        case "workflow_tools":
          toolInfos = message.toolDefs ?? [];
          profileNames = message.profiles ?? [];
          steps.refreshTools();
          return true;
        case "workflows":
          entries = message.workflows ?? [];
          renderAll();
          return true;
        case "workflow":
          if (isRef(current, message)) {
            steps.show(message.steps ?? []);
            saveBtn.disabled = false;
          }
          return true;
        case "workflow_result":
          if (!message.ok) say(message.error ?? "failed", true);
          else if (message.deleted) {
            edit(null);
            say("Deleted.");
          } else {
            current = {
              name: message.name ?? "",
              scope: message.scope ?? "project",
            };
            name.disabled = scope.disabled = true;
            deleteBtn.disabled = false;
            say("Saved.");
          }
          return true;
        default:
          return false;
      }
    },
  };
}
