import { make } from "../dom.ts";
interface WorkflowEntry {
  name: string;
  scope: string;
}

/** The slice of a server message the picker reads (`workflows`: the saved list; `workflow`: a run's progress). */
export interface WorkflowListMessage {
  type: string;
  workflows?: WorkflowEntry[];
  /** `workflow`: start, step, end, or profile (a stopped run left the session in another profile). */
  kind?: string;
  name?: string;
  step?: number;
  total?: number;
  label?: string;
  /** `workflow`: the line for the chat log, and how it should look. */
  text?: string;
  level?: string;
  /** `workflow` / `profile`: the profile the session is in now ("" for none). */
  profile?: string;
}

/** Close a dialog and take it out of the page (its own `close` event is queued and may come late). */
function dismiss(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
  dialog.remove();
}

/** What a `workflow` message changes: the strip, the chat log, and the profile select. */
function followRun(
  message: WorkflowListMessage,
  ui: {
    showStrip(title: string | null): void;
    addLine(cls: string, text: string): void;
    showProfile(name: string): void;
  },
): void {
  const name = message.name ?? "";
  if (message.kind === "profile") {
    ui.showProfile(message.profile ?? "");
  } else if (message.kind === "start") {
    ui.showStrip(`Running workflow ${name}…`);
  } else if (message.kind === "step") {
    const label = message.label ? ` · ${message.label}` : "";
    ui.showStrip(`Workflow ${name} · step ${message.step}/${message.total}${label}`);
  } else if (message.kind === "end") {
    ui.showStrip(null);
  }
  if (message.text) ui.addLine(`system goal-${message.level ?? "info"}`, message.text);
}

/**
 * Agent → Run workflow…: a dialog listing the saved workflows with an input
 * box; Run sends `/workflow <name> [input]` like the slash command. While it
 * runs, the strip above the composer names it and its step ("step 3/6 · commit",
 * from the server's `workflow` messages, so it also follows a workflow started
 * by its shortcut `/implement`) and offers Stop; each step and the end are lines
 * in the chat. The list comes from the `workflows` message the settings tab
 * also uses (the picker only reads it).
 */
export function createWorkflowPicker(
  send: (msg: Record<string, unknown>) => void,
  run: (line: string) => void,
  strip: HTMLElement,
  stop: () => void,
  addLine: (cls: string, text: string) => void,
  /** A stopped run left the session in this profile ("" for none): the profile select follows. */
  showProfile: (name: string) => void,
): {
  open(): void;
  /** The line now running (null when it ended): the strip follows. */
  running(line: string | null): void;
  /** Observe a server message (never consumes it). */
  observe(message: WorkflowListMessage): void;
} {
  let workflows: WorkflowEntry[] = [];
  let dialog: HTMLDialogElement | null = null;

  /** Fill the strip: a title and Stop (hidden when `title` is null). */
  function showStrip(title: string | null): void {
    strip.textContent = "";
    strip.classList.toggle("hidden", title === null);
    if (title === null) return;
    const stopBtn = make("button", "btn btn--danger btn--sm", "Stop");
    stopBtn.type = "button";
    stopBtn.addEventListener("click", stop);
    strip.append(make("span", "wfrun-title", title), stopBtn);
  }

  function render(target: HTMLDialogElement): void {
    target.textContent = "";
    target.append(make("h2", "confirm-title", "Run a workflow"));
    if (workflows.length === 0) {
      target.append(make("p", "confirm-message", "No workflows yet. Create one in Settings → Workflows."));
      const close = make("button", "btn btn--lg", "Close");
      close.type = "button";
      close.addEventListener("click", () => dismiss(target));
      const row = make("div", "actions confirm-actions");
      row.append(close);
      target.append(row);
      return;
    }
    const form = make("form", "picker-form");
    form.method = "dialog";
    const label = make("label", "form-label", "Workflow");
    const select = make("select", "field");
    select.id = "wf-pick";
    label.htmlFor = select.id;
    for (const wf of workflows) select.append(new Option(`${wf.name} · ${wf.scope}`, wf.name));
    const inputLabel = make("label", "form-label", "Input (optional)");
    const input = make("textarea", "field field--mono");
    input.id = "wf-input";
    input.rows = 3;
    inputLabel.htmlFor = input.id;
    const cancel = make("button", "btn btn--lg", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => dismiss(target));
    const go = make("button", "btn btn--lg btn--primary", "Run");
    go.type = "submit";
    const row = make("div", "actions confirm-actions");
    row.append(cancel, go);
    form.append(label, select, inputLabel, input, row);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      dismiss(target);
      run(`/workflow ${select.value}${text ? ` ${text}` : ""}`);
    });
    target.append(form);
    setTimeout(() => select.focus());
  }

  return {
    open() {
      send({ type: "workflows_list" });
      dialog?.remove();
      dialog = make("dialog", "confirm-dialog picker-dialog");
      dialog.setAttribute("aria-label", "Run a workflow");
      const opened = dialog;
      opened.addEventListener("close", () => opened.remove());
      document.body.append(opened);
      render(opened);
      opened.showModal();
    },
    running(line) {
      const match = line ? /^\/workflow\s+(\S+)/.exec(line) : null;
      if (match) {
        const name = match[1];
        showStrip(name === "init" ? null : `Running workflow ${name}…`);
        return;
      }
      if (!line) return showStrip(null);
      const bare = line.startsWith("/") ? line.slice(1).split(/\s/)[0] : null;
      showStrip(bare && workflows.some((w) => w.name === bare) ? `Running workflow ${bare}…` : null);
    },
    observe(message) {
      if (message.type === "workflow") {
        followRun(message, { showStrip, addLine, showProfile });
        return;
      }
      if (message.type !== "workflows") return;
      workflows = message.workflows ?? [];
      if (dialog?.open) render(dialog);
    },
  };
}
