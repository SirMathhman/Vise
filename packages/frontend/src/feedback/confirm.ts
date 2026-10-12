/** What a confirmation asks. */
export interface ConfirmRequest {
  title: string;
  /** One or two sentences: what will happen, and whether it can be undone. */
  message?: string;
  /** The button that goes ahead (default "Delete"). */
  confirmLabel?: string;
  /** Whether going ahead destroys something (a red button). Default true. */
  danger?: boolean;
}

/**
 * Ask before doing something that cannot be undone: a modal `<dialog>` with
 * Cancel and the action, in the page's own style (the browser's `confirm()`
 * looks foreign and blocks the page). Escape or Cancel answers no, and focus
 * returns to where it was.
 */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-labelledby", "confirm-title");
  const title = document.createElement("h2");
  title.id = "confirm-title";
  title.className = "confirm-title";
  title.textContent = request.title;
  dialog.appendChild(title);
  if (request.message) {
    const text = document.createElement("p");
    text.className = "confirm-message";
    text.textContent = request.message;
    dialog.appendChild(text);
  }
  const actions = document.createElement("div");
  actions.className = "actions confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn--lg";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = `btn btn--lg ${request.danger === false ? "btn--primary" : "btn--danger"}`;
  ok.textContent = request.confirmLabel ?? "Delete";
  actions.append(cancel, ok);
  dialog.appendChild(actions);
  const returnTo = document.activeElement as HTMLElement | null;
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    let done = false;
    // Answered from the buttons and Escape themselves: the dialog's own `close` event is queued and may come late.
    const finish = (answer: boolean): void => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      returnTo?.focus();
      resolve(answer);
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("close", () => finish(false));
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    dialog.showModal();
    // The safe answer has the focus, so a stray Enter does not destroy anything.
    cancel.focus();
  });
}

/** Ask, then run `action` only on a yes. */
export function ifConfirmed(request: ConfirmRequest, action: () => void): void {
  void confirmAction(request).then((yes) => {
    if (yes) action();
  });
}
