/**
 * Content script: page dialogs (`alert`, `confirm`, `prompt`) freeze a page
 * until someone answers, and an extension cannot see or answer them. So they
 * are replaced, in the page's own window, by versions that answer at once
 * (alert accepted, confirm declined, prompt cancelled) and remember what was
 * asked; the snapshot reports it to the agent.
 */

declare function exportFunction<T>(fn: T, target: object): T;

interface RaisedDialog {
  type: string;
  message: string;
  answer: string;
}

const raised: RaisedDialog[] = [];
(window as unknown as { __viseDialogs: RaisedDialog[] }).__viseDialogs = raised;

const page = (window as unknown as { wrappedJSObject: Record<string, unknown> }).wrappedJSObject;

function replace(name: string, answer: string, value: boolean | null | undefined): void {
  page[name] = exportFunction((message?: unknown) => {
    raised.push({ type: name, message: String(message ?? ""), answer });
    return value;
  }, page);
}

replace("alert", "accepted", undefined);
replace("confirm", "declined", false);
replace("prompt", "cancelled", null);
