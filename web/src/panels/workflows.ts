// The Workflows panel: the saved workflows, and an editor for one. Each step is picked by type, and only the fields for
// that type are shown, so a workflow is built from fields rather than typed as JSON. The server checks a workflow again
// on save, and the editor checks the obvious mistakes first, so each one is shown beside the step that has it.

// One step as the editor holds it. A tool step either lets the model supply its arguments, or has fixed ones, which are
// held as text until they are saved.
type WorkflowStep =
  | { type: "instructions"; text: string }
  | { type: "profile"; reference: string }
  | { type: "tool"; name: string; fixed: boolean; args: { key: string; value: string }[] };

const workflowsList = document.getElementById("workflows-list") as HTMLUListElement;
const workflowsStatus = document.getElementById("workflows-status") as HTMLParagraphElement;
const workflowNew = document.getElementById("workflow-new") as HTMLButtonElement;
const workflowForm = document.getElementById("workflow-form") as HTMLFormElement;
const workflowName = document.getElementById("workflow-name") as HTMLInputElement;
const workflowSteps = document.getElementById("workflow-steps") as HTMLOListElement;
const workflowRun = document.getElementById("workflow-run") as HTMLButtonElement;
const workflowDelete = document.getElementById("workflow-delete") as HTMLButtonElement;
const workflowAddInstructions = document.getElementById("workflow-add-instructions") as HTMLButtonElement;
const workflowAddProfile = document.getElementById("workflow-add-profile") as HTMLButtonElement;
const workflowAddTool = document.getElementById("workflow-add-tool") as HTMLButtonElement;

// The tools and profiles the editor offers, as the server lists them on refresh.
let workflowTools: string[] = [];
let workflowProfiles: string[] = [];
// The workflow open in the editor, by name. Null while a new one is written.
let workflowEditing: string | null = null;
let workflowDraft: WorkflowStep[] = [];

// Reloads the list of workflows, and the tools and profiles the editor offers. An open editor keeps what is in it.
async function refreshWorkflows(): Promise<void> {
  try {
    const [{ workflows, tools }, { notes }] = await Promise.all([
      postJson<{ workflows: string[]; tools: string[] }>("/api/workflows", { action: "list" }),
      postJson<{ notes: { scope: string; category: string; name: string }[] }>("/api/notes", { action: "profiles" }),
    ]);
    workflowTools = tools;
    workflowProfiles = notes.map((note) => `${note.scope}/${note.category}/${note.name}`);
    workflowsList.replaceChildren(
      ...workflows.map((name) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = name;
        button.addEventListener("click", () => {
          void openWorkflow(name);
        });
        item.append(button);
        return item;
      }),
    );
  } catch (err) {
    showStatus(workflowsStatus, errorMessage(err), true);
  }
}

// Opens a saved workflow in the editor.
async function openWorkflow(name: string): Promise<void> {
  try {
    const { steps } = await postJson<{ steps: Record<string, unknown>[] }>("/api/workflows", { action: "load", name });
    workflowEditing = name;
    workflowDraft = steps.map(fromJsonStep);
    showWorkflowEditor(true);
  } catch (err) {
    showStatus(workflowsStatus, errorMessage(err), true);
  }
}

// Shows the editor, or hides it, and fills it from the draft. A saved workflow's name cannot be changed here.
function showWorkflowEditor(open: boolean): void {
  workflowForm.hidden = !open;
  workflowName.value = workflowEditing ?? workflowName.value;
  workflowName.disabled = workflowEditing !== null;
  workflowRun.hidden = workflowEditing === null;
  workflowDelete.hidden = workflowEditing === null;
  renderWorkflowSteps();
}

function fromJsonStep(step: Record<string, unknown>): WorkflowStep {
  if (typeof step.instructions === "string") {
    return { type: "instructions", text: step.instructions };
  }
  if (typeof step.profile === "string") {
    return { type: "profile", reference: step.profile };
  }
  const args = (step.arguments ?? null) as Record<string, unknown> | null;
  return {
    type: "tool",
    name: String(step.tool),
    fixed: args !== null,
    args: Object.entries(args ?? {}).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    })),
  };
}

function toJsonStep(step: WorkflowStep): Record<string, unknown> {
  if (step.type === "instructions") {
    return { instructions: step.text };
  }
  if (step.type === "profile") {
    return { profile: step.reference };
  }
  if (!step.fixed) {
    return { tool: step.name };
  }
  return { tool: step.name, arguments: Object.fromEntries(step.args.map((arg) => [arg.key, argumentValue(arg.value)])) };
}

// A fixed argument is sent as a number or a boolean when its text reads as one, and as text otherwise.
function argumentValue(text: string): string | number | boolean {
  if (text === "true" || text === "false") {
    return text === "true";
  }
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

// The first problem with the workflow as it stands, or null when it can be saved.
function workflowProblem(name: string): string | null {
  if (name === "") {
    return "Give the workflow a name.";
  }
  if (workflowDraft.length === 0) {
    return "Add at least one step.";
  }
  for (const [index, step] of workflowDraft.entries()) {
    const where = `Step ${index + 1}`;
    if (step.type === "instructions" && step.text.trim() === "") {
      return `${where} needs instructions.`;
    }
    if (step.type === "profile" && step.reference === "") {
      return `${where} needs a profile.`;
    }
    if (step.type === "tool" && step.name === "") {
      return `${where} needs a tool.`;
    }
    if (step.type === "tool" && step.fixed) {
      const keys = step.args.map((arg) => arg.key.trim());
      if (keys.includes("")) {
        return `${where} has an argument with no name.`;
      }
      if (new Set(keys).size !== keys.length) {
        return `${where} names an argument twice.`;
      }
    }
  }
  return null;
}

function renderWorkflowSteps(): void {
  workflowSteps.replaceChildren(...workflowDraft.map((step, index) => workflowStepItem(step, index)));
}

// Adds a button that does one thing to a step, and is shown with the given text.
function stepButton(text: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

// One step in the editor: its type, its move and remove buttons, and the fields for its type.
function workflowStepItem(step: WorkflowStep, index: number): HTMLLIElement {
  const item = document.createElement("li");
  const head = document.createElement("div");
  head.className = "step-head";
  const label = document.createElement("strong");
  label.textContent = step.type === "instructions" ? "Instructions" : step.type === "profile" ? "Profile" : "Tool";
  const move = (to: number) => () => {
    [workflowDraft[index], workflowDraft[to]] = [workflowDraft[to], workflowDraft[index]];
    renderWorkflowSteps();
  };
  head.append(
    label,
    stepButton("Up", index === 0, move(index - 1)),
    stepButton("Down", index === workflowDraft.length - 1, move(index + 1)),
    stepButton("Remove", false, () => {
      workflowDraft.splice(index, 1);
      renderWorkflowSteps();
    }),
  );
  item.append(head);

  if (step.type === "instructions") {
    const text = document.createElement("textarea");
    text.rows = 3;
    text.value = step.text;
    text.setAttribute("aria-label", `Step ${index + 1} instructions`);
    text.addEventListener("input", () => {
      step.text = text.value;
    });
    const hint = document.createElement("p");
    hint.className = "description";
    hint.textContent = "{argument} is replaced by the argument typed after the workflow's name.";
    item.append(text, hint);
  } else if (step.type === "profile") {
    item.append(profileSelect(step, index));
  } else {
    item.append(toolFields(step, index));
  }
  return item;
}

function profileSelect(step: { reference: string }, index: number): HTMLSelectElement {
  const select = document.createElement("select");
  select.setAttribute("aria-label", `Step ${index + 1} profile`);
  const choices = ["default", ...workflowProfiles.filter((reference) => reference !== "default")];
  if (step.reference !== "" && !choices.includes(step.reference)) {
    // A profile that has since been removed stays shown, so the user can see what the step names.
    choices.push(step.reference);
  }
  select.append(new Option("Choose a profile…", ""));
  for (const reference of choices) {
    select.append(new Option(reference, reference, false, reference === step.reference));
  }
  select.addEventListener("change", () => {
    step.reference = select.value;
  });
  return select;
}

// A tool step's fields: the tool, whether the model supplies the arguments, and the fixed arguments when it does not.
function toolFields(step: Extract<WorkflowStep, { type: "tool" }>, index: number): HTMLDivElement {
  const fields = document.createElement("div");
  const tool = document.createElement("select");
  tool.setAttribute("aria-label", `Step ${index + 1} tool`);
  tool.append(new Option("Choose a tool…", ""));
  for (const name of workflowTools) {
    tool.append(new Option(name, name, false, name === step.name));
  }
  tool.addEventListener("change", () => {
    step.name = tool.value;
  });

  const mode = document.createElement("select");
  mode.setAttribute("aria-label", `Step ${index + 1} arguments`);
  mode.append(new Option("Model supplies the arguments", "model", false, !step.fixed));
  mode.append(new Option("Fixed arguments", "fixed", false, step.fixed));
  mode.addEventListener("change", () => {
    step.fixed = mode.value === "fixed";
    renderWorkflowSteps();
  });
  fields.append(tool, mode);

  if (step.fixed) {
    fields.append(fixedArguments(step, index));
  }
  return fields;
}

// The fixed arguments of a tool step, one name and value per row.
function fixedArguments(step: Extract<WorkflowStep, { type: "tool" }>, index: number): HTMLDivElement {
  const list = document.createElement("div");
  list.className = "workflow-args";
  step.args.forEach((arg, row) => {
    const line = document.createElement("div");
    const key = document.createElement("input");
    key.placeholder = "name";
    key.value = arg.key;
    key.setAttribute("aria-label", `Step ${index + 1} argument ${row + 1} name`);
    key.addEventListener("input", () => {
      arg.key = key.value;
    });
    const value = document.createElement("input");
    value.placeholder = "value";
    value.value = arg.value;
    value.setAttribute("aria-label", `Step ${index + 1} argument ${row + 1} value`);
    value.addEventListener("input", () => {
      arg.value = value.value;
    });
    const remove = stepButton("Remove", false, () => {
      step.args.splice(row, 1);
      renderWorkflowSteps();
    });
    line.append(key, value, remove);
    list.append(line);
  });
  const add = stepButton("Add argument", false, () => {
    step.args.push({ key: "", value: "" });
    renderWorkflowSteps();
  });
  const hint = document.createElement("p");
  hint.className = "description";
  hint.textContent = "A value that reads as a number, true or false is sent as that; any other value is sent as text.";
  list.append(add, hint);
  return list;
}

workflowNew.addEventListener("click", () => {
  workflowEditing = null;
  workflowDraft = [];
  workflowName.value = "";
  showWorkflowEditor(true);
});

workflowAddInstructions.addEventListener("click", () => {
  workflowDraft.push({ type: "instructions", text: "" });
  renderWorkflowSteps();
});

workflowAddProfile.addEventListener("click", () => {
  workflowDraft.push({ type: "profile", reference: "" });
  renderWorkflowSteps();
});

workflowAddTool.addEventListener("click", () => {
  workflowDraft.push({ type: "tool", name: "", fixed: false, args: [] });
  renderWorkflowSteps();
});

workflowForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = workflowEditing ?? workflowName.value.trim();
  const problem = workflowProblem(name);
  if (problem !== null) {
    showStatus(workflowsStatus, problem, true);
    return;
  }
  try {
    const { message } = await postJson<{ message: string }>("/api/workflows", {
      action: "save",
      name,
      steps: workflowDraft.map(toJsonStep),
    });
    workflowEditing = name;
    showWorkflowEditor(true);
    showStatus(workflowsStatus, message, false);
    await refreshWorkflows();
  } catch (err) {
    showStatus(workflowsStatus, errorMessage(err), true);
  }
});

// Puts the workflow's name in the chat's input, so its argument can be typed after it and sent.
workflowRun.addEventListener("click", () => {
  if (workflowEditing !== null) {
    input.value = `/${workflowEditing} `;
    input.focus();
  }
});

workflowDelete.addEventListener("click", async () => {
  if (workflowEditing === null || !confirm(`Delete workflow ${workflowEditing}?`)) {
    return;
  }
  try {
    const { message } = await postJson<{ message: string }>("/api/workflows", { action: "delete", name: workflowEditing });
    workflowEditing = null;
    workflowDraft = [];
    showWorkflowEditor(false);
    showStatus(workflowsStatus, message, false);
    await refreshWorkflows();
  } catch (err) {
    showStatus(workflowsStatus, errorMessage(err), true);
  }
});
