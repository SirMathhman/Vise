// The Workflows panel: the saved workflows, and an editor for one. Each step is picked by type, and only the fields for
// that type are shown, so a workflow is built from fields rather than typed as JSON. The server checks a workflow again
// on save, and the editor checks the obvious mistakes first, so each one is shown beside the step that has it.

// A parameter a tool declares, as the server lists it. A parameter with a listed set of choices has `enum`.
interface ToolParameter {
  name: string;
  type: string;
  enum: string[] | null;
  minimum: number | null;
  description: string | null;
}

interface ToolInfo {
  name: string;
  parameters: ToolParameter[];
}

// One step as the editor holds it. A tool step either lets the model supply its arguments, or has fixed ones: a text for
// each parameter its tool declares, held until they are saved.
type WorkflowStep =
  | { type: "instructions"; text: string }
  | { type: "profile"; reference: string }
  | { type: "tool"; name: string; fixed: boolean; args: Record<string, string> };

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
let workflowTools: ToolInfo[] = [];
let workflowProfiles: string[] = [];
// The workflow open in the editor, by name. Null while a new one is written.
let workflowEditing: string | null = null;
let workflowDraft: WorkflowStep[] = [];

// Reloads the list of workflows, and the tools and profiles the editor offers. An open editor keeps what is in it.
async function refreshWorkflows(): Promise<void> {
  try {
    const [{ workflows, tools }, { notes }] = await Promise.all([
      postJson<{ workflows: string[]; tools: ToolInfo[] }>("/api/workflows", { action: "list" }),
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
    args: Object.fromEntries(
      Object.entries(args ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
    ),
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
  // Every argument is sent as the text chosen or typed. The server reads each one as its tool's parameter type.
  return { tool: step.name, arguments: { ...step.args } };
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
      // Every parameter the tool declares must have a value. The server checks the values' types as well.
      const tool = workflowTools.find((known) => known.name === step.name);
      for (const parameter of tool?.parameters ?? []) {
        if ((step.args[parameter.name] ?? "").trim() === "") {
          return `${where} needs a value for ${parameter.name}.`;
        }
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
  for (const known of workflowTools) {
    tool.append(new Option(known.name, known.name, false, known.name === step.name));
  }
  tool.addEventListener("change", () => {
    // Another tool takes other arguments, so the values of the last one are dropped.
    step.name = tool.value;
    step.args = {};
    renderWorkflowSteps();
  });

  const mode = document.createElement("select");
  mode.setAttribute("aria-label", `Step ${index + 1} arguments`);
  mode.append(new Option("Model supplies", "model", false, !step.fixed));
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

// The fixed arguments of a tool step: one field for each parameter the tool declares, and no others. Every one is required.
function fixedArguments(step: Extract<WorkflowStep, { type: "tool" }>, index: number): HTMLDivElement {
  const list = document.createElement("div");
  list.className = "workflow-args";
  const tool = workflowTools.find((known) => known.name === step.name);
  if (tool === undefined) {
    const hint = document.createElement("p");
    hint.className = "description";
    hint.textContent = "Choose a tool to see the arguments it takes.";
    list.append(hint);
    return list;
  }
  for (const parameter of tool.parameters) {
    step.args[parameter.name] ??= "";
    list.append(argumentField(step, parameter, index));
  }
  const hint = document.createElement("p");
  hint.className = "description";
  hint.textContent = "Every argument the tool takes is required.";
  list.append(hint);
  return list;
}

// One argument's field, shaped by its parameter: a choice box for a listed set of values, a number box for a number,
// and a text box otherwise.
function argumentField(step: Extract<WorkflowStep, { type: "tool" }>, parameter: ToolParameter, index: number): HTMLLabelElement {
  const row = document.createElement("label");
  row.title = parameter.description ?? parameter.name;
  row.append(`${parameter.name} `);
  const label = `Step ${index + 1} argument ${parameter.name}`;
  const current = step.args[parameter.name];
  const set = (value: string) => {
    step.args[parameter.name] = value;
  };

  if (parameter.enum !== null || parameter.type === "boolean") {
    const choices = parameter.enum ?? ["true", "false"];
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    select.append(new Option("Choose…", ""));
    for (const choice of choices) {
      select.append(new Option(choice, choice, false, choice === current));
    }
    select.addEventListener("change", () => set(select.value));
    row.append(select);
  } else {
    const input = document.createElement("input");
    input.setAttribute("aria-label", label);
    if (parameter.type === "integer" || parameter.type === "number") {
      input.type = "number";
      input.step = parameter.type === "integer" ? "1" : "any";
      if (parameter.minimum !== null) {
        input.min = String(parameter.minimum);
      }
    }
    input.value = current;
    input.addEventListener("input", () => set(input.value));
    row.append(input);
  }
  return row;
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
  workflowDraft.push({ type: "tool", name: "", fixed: false, args: {} });
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
