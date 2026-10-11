interface WorkflowEntry {
  name: string;
  scope: string;
}

/** The slice of a server message the picker reads. */
export interface WorkflowListMessage {
  type: string;
  workflows?: WorkflowEntry[];
}

/** Close a dialog and take it out of the page (its own `close` event is queued and may come late). */
function dismiss(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
  dialog.remove();
}

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

/**
 * Agent → Run workflow…: a dialog listing the saved workflows with an input
 * box; Run sends `/workflow <name> [input]` like the slash command. While it
 * runs, the strip above the composer names it and offers Stop. The list comes
 * from the `workflows` message the settings tab also uses (the picker only
 * reads it).
 */
export function createWorkflowPicker(
  send: (msg: Record<string, unknown>) => void,
  run: (line: string) => void,
  strip: HTMLElement,
  stop: () => void,
): {
  open(): void;
  /** The line now running (null when it ended): the strip follows. */
  running(line: string | null): void;
  /** Observe a server message (never consumes it). */
  observe(message: WorkflowListMessage): void;
} {
  let workflows: WorkflowEntry[] = [];
  let dialog: HTMLDialogElement | null = null;

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
      const name = match?.[1];
      strip.textContent = "";
      strip.classList.toggle("hidden", !name || name === "init");
      if (!name || name === "init") return;
      const title = make("span", "wfrun-title", `Running workflow ${name}…`);
      const stopBtn = make("button", "btn btn--danger btn--sm", "Stop");
      stopBtn.type = "button";
      stopBtn.addEventListener("click", stop);
      strip.append(title, stopBtn);
    },
    observe(message) {
      if (message.type !== "workflows") return;
      workflows = message.workflows ?? [];
      if (dialog?.open) render(dialog);
    },
  };
}
