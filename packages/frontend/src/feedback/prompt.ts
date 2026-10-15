/** What a prompt asks. */
export interface PromptRequest {
  title: string;
  /** Placeholder text for the input field. */
  placeholder?: string;
}

/**
 * Ask for a name: a modal `<dialog>` with a text input and Cancel/OK. The
 * browser's `prompt()` looks foreign and blocks the page, so this uses the
 * same `<dialog>` approach as `confirmAction`. Escape or Cancel resolves
 * null; OK resolves the entered string.
 */
export function promptAction(request: PromptRequest): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-labelledby", "prompt-title");
  const title = document.createElement("h2");
  title.id = "prompt-title";
  title.className = "confirm-title";
  title.textContent = request.title;
  dialog.appendChild(title);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "field";
  input.placeholder = request.placeholder ?? "";
  dialog.appendChild(input);
  const actions = document.createElement("div");
  actions.className = "actions confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn--lg";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn btn--lg btn--primary";
  ok.textContent = "OK";
  actions.append(cancel, ok);
  dialog.appendChild(actions);
  const returnTo = document.activeElement as HTMLElement | null;
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: string | null): void => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      returnTo?.focus();
      resolve(answer);
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener("close", () => finish(null));
    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", () => {
      const text = input.value.trim();
      finish(text || null);
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const text = input.value.trim();
        finish(text || null);
      }
    });
    dialog.showModal();
    input.focus();
    input.select();
  });
}
