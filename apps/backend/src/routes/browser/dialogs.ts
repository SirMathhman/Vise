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
  /** Whether a dialog is currently open (the page is blocked on it). */
  isOpen(): boolean;
  /** Throw the "a dialog is open" error if one is; for actions that bypass `guard`. */
  assertClosed(): void;
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
  // The action blocked on the open dialog, so `answer` can let it finish. It
  // resolves to the action's error, if it failed, so `answer` can report it.
  let blocked: Promise<Error | undefined> | undefined;
  let onOpen: (() => void) | undefined;

  page.on("dialog", (d) => {
    open = d;
    onOpen?.();
  });
  // Playwright has no "dialog closed" event, so a dialog the page resolved
  // itself (e.g. beforeunload on navigation) or one that died with the page
  // would otherwise stay "open" forever and wedge every later action.
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) open = undefined;
  });
  page.on("close", () => {
    open = undefined;
  });

  function assertClosed(): void {
    if (open) {
      throw badRequest(`a dialog is open: ${describe(open)}; ${ANSWER_HINT}`);
    }
  }

  return {
    isOpen: () => open !== undefined,
    assertClosed,

    async guard(run) {
      assertClosed();
      const done = run();
      blocked = done.then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
      );
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
      try {
        if (action === "accept") {
          await d.accept(typeof args.text === "string" ? args.text : undefined);
        } else {
          await d.dismiss();
        }
      } catch {
        // The dialog is already gone (the page moved on or closed); nothing
        // left to answer, so carry on with a fresh snapshot.
        return `${describe(d)} was already gone.`;
      }
      // Let the action that was blocked on the dialog finish before the caller
      // reads the page again, and surface its failure if it had one.
      const failure = await blocked;
      blocked = undefined;
      const verb = action === "accept" ? "Accepted" : "Dismissed";
      return `${verb} ${describe(d)}.${failure ? ` The action that opened it then failed: ${failure.message}` : ""}`;
    },
  };
}
