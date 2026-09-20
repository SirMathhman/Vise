import type { Dialog, Page } from "playwright-core";
import { badRequest } from "../../errors.js";

/**
 * JavaScript dialogs (alert/confirm/prompt/beforeunload) block the whole page
 * until answered, and Playwright auto-dismisses them when nothing listens. A
 * DialogWatch listens instead and holds the dialog open, so the model can read
 * it and decide (browser_dialog). While one is open, every page action would
 * hang, so `guard` reports the dialog in place of the action's result and
 * refuses new actions until it is answered.
 */
export interface DialogWatch {
  /**
   * Run a page action. If a dialog opens before the action finishes (the
   * action is then blocked on it), return a description of the dialog instead
   * of waiting; if one is already open, refuse to start the action.
   */
  guard(run: () => Promise<string>): Promise<string>;
  /** browser_dialog: accept or dismiss the open dialog. */
  answer(args: Record<string, unknown>): Promise<string>;
}

/** A one-line, model-readable description of a dialog. */
function describe(d: Dialog): string {
  const prompt =
    d.type() === "prompt" ? ` (default "${d.defaultValue()}")` : "";
  return `[${d.type()}] "${d.message()}"${prompt}`;
}

const ANSWER_HINT = "call browser_dialog to accept or dismiss it";

export function watchDialogs(page: Page): DialogWatch {
  let open: Dialog | undefined;
  // The action blocked on the open dialog, so `answer` can let it finish.
  let blocked: Promise<unknown> | undefined;
  let onOpen: (() => void) | undefined;

  page.on("dialog", (d) => {
    open = d;
    onOpen?.();
  });

  return {
    async guard(run) {
      if (open) {
        throw badRequest(`a dialog is open: ${describe(open)}; ${ANSWER_HINT}`);
      }
      const done = run();
      blocked = done.catch(() => undefined);
      const opened = new Promise<void>((resolve) => {
        onOpen = resolve;
      });
      try {
        const result = await Promise.race([done, opened.then(() => undefined)]);
        if (result !== undefined) return result;
      } finally {
        onOpen = undefined;
      }
      // A dialog opened before (or right as) the action finished; the action
      // stays blocked on it until answered.
      return `The action opened a dialog: ${open ? describe(open) : "(gone)"}. The page is blocked until you ${ANSWER_HINT}.`;
    },

    async answer(args) {
      const action = args.action;
      if (action !== "accept" && action !== "dismiss") {
        throw badRequest('action must be "accept" or "dismiss"');
      }
      const d = open;
      if (!d) throw badRequest("no dialog is open");
      open = undefined;
      if (action === "accept") {
        await d.accept(typeof args.text === "string" ? args.text : undefined);
      } else {
        await d.dismiss();
      }
      // Let the action that was blocked on the dialog finish before the caller
      // reads the page again.
      await blocked;
      blocked = undefined;
      return `${action === "accept" ? "Accepted" : "Dismissed"} ${describe(d)}.`;
    },
  };
}
