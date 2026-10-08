type Step =
  | { type: "instruction"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> };

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
  ok?: boolean;
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

/** One editable step row; `read()` returns the step or throws a message for the user. */
function stepRow(step: Step, move: (by: number) => void, drop: () => void) {
  const row = make("div", "wf-step");
  const kind = make("select", "save-input");
  kind.append(new Option("instruction", "instruction"));
  kind.append(new Option("tool call", "tool"));
  kind.value = step.type;
  const text = make("textarea", "note-text");
  text.rows = 3;
  const toolName = make("input", "save-input");
  toolName.placeholder = "tool name";
  const args = make("textarea", "note-text");
  args.rows = 3;
  args.placeholder = "arguments as a JSON object";
  if (step.type === "instruction") text.value = step.text;
  else {
    toolName.value = step.name;
    args.value = JSON.stringify(step.args, null, 2);
  }
  const show = (): void => {
    const isTool = kind.value === "tool";
    text.hidden = isTool;
    toolName.hidden = !isTool;
    args.hidden = !isTool;
  };
  kind.addEventListener("change", show);
  show();
  const bar = make("div", "save-row");
  for (const [label, action] of [
    ["↑", () => move(-1)],
    ["↓", () => move(1)],
    ["✕", drop],
  ] as const) {
    const button = make("button", "tools-btn", label);
    button.type = "button";
    button.addEventListener("click", action);
    bar.append(button);
  }
  row.append(kind, text, toolName, args, bar);
  const read = (): Step => {
    if (kind.value === "instruction") {
      return { type: "instruction", text: text.value };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.value.trim() || "{}");
    } catch {
      throw new Error(`arguments of '${toolName.value}' are not valid JSON`);
    }
    return {
      type: "tool",
      name: toolName.value,
      args: parsed as Record<string, unknown>,
    };
  };
  return { row, read };
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
    const button = make("button", "note-item", `${entry.scope} · ${label}`);
    button.setAttribute("aria-current", String(isRef(current, entry)));
    button.addEventListener("click", () => open(entry));
    item.append(button);
    list.append(item);
  }
  if (entries.length === 0) {
    list.append(make("li", "note-group", "no workflows yet"));
  }
}

/** The ordered, editable step rows inside `box`. */
function createStepList(box: HTMLElement) {
  let rows: ReturnType<typeof stepRow>[] = [];
  function add(step: Step): void {
    const index = (): number => rows.indexOf(entry);
    const entry = stepRow(
      step,
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
  };
}

/** The panel's elements: the workflow list on the left, the editor on the right. */
function buildUi() {
  const list = make("ul", "tools-list");
  const name = make("input", "save-input");
  name.placeholder = "name";
  name.autocomplete = "off";
  const scope = make("select", "save-input");
  scope.append(new Option("project (this project only)", "project"));
  scope.append(new Option("global (every project)", "global"));
  scope.setAttribute("aria-label", "scope");
  const stepsBox = make("div", "wf-steps");
  const addBtn = make("button", "tools-btn", "+ add step");
  const saveBtn = make("button", "save-btn", "save");
  const deleteBtn = make("button", "tools-btn", "delete");
  const newBtn = make("button", "tools-btn", "+ new workflow");
  const status = make("span", "pe-status");
  status.setAttribute("role", "status");
  const buttons = make("div", "save-row");
  buttons.append(saveBtn, deleteBtn, status);
  const left = make("div", "notes-side");
  left.append(newBtn, list);
  const right = make("div", "notes-edit");
  right.append(name, scope, stepsBox, addBtn, buttons);
  const layout = make("div", "notes-layout");
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
  let entries: WorkflowEntry[] = [];
  const ui = buildUi();
  const { list, name, scope, saveBtn, deleteBtn, status } = ui;
  const steps = createStepList(ui.stepsBox);

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
  ui.addBtn.addEventListener("click", () =>
    steps.add({ type: "instruction", text: "" }),
  );
  saveBtn.addEventListener("click", () => {
    try {
      const read = steps.read();
      say("saving…");
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
  deleteBtn.addEventListener("click", () => {
    const target = current;
    if (!target || !confirm(`Delete workflow '${target.name}'?`)) return;
    send({ type: "workflow_delete", ...target });
  });
  for (const trigger of refreshOn) {
    trigger.addEventListener("click", () => send({ type: "workflows_list" }));
  }

  body.append(ui.layout);
  edit(null);

  return {
    handle(message) {
      switch (message.type) {
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
            say("deleted");
          } else {
            current = {
              name: message.name ?? "",
              scope: message.scope ?? "project",
            };
            name.disabled = scope.disabled = true;
            deleteBtn.disabled = false;
            say("saved");
          }
          return true;
        default:
          return false;
      }
    },
  };
}
