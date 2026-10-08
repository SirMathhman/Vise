import { answerFrom, decideKey } from "./ask-choices.ts";
import type { ServerMessage } from "./server-message.ts";

/** A choice as a button with its number (keys 1-9 choose it); a toggle when several may be chosen. */
function choiceButton(
  choice: string,
  index: number,
  multi: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ask-option";
  if (multi) button.setAttribute("aria-pressed", "false");
  if (index < 9) button.setAttribute("aria-keyshortcuts", String(index + 1));
  const key = document.createElement("span");
  key.className = "ask-key";
  key.setAttribute("aria-hidden", "true");
  key.textContent = index < 9 ? String(index + 1) : "·";
  button.append(key, document.createTextNode(choice));
  return button;
}

/** The choices as a list of buttons; `onPick` hears the chosen one. */
function renderChoices(
  list: HTMLUListElement,
  choices: string[],
  multi: boolean,
  onPick: (index: number) => void,
): HTMLButtonElement[] {
  return choices.map((choice, index) => {
    const button = choiceButton(choice, index, multi);
    button.addEventListener("click", () => onPick(index));
    const item = document.createElement("li");
    item.append(button);
    list.append(item);
    return button;
  });
}

/** Give the keyboard back to what had it before the question (unless that is gone or inside the question). */
function restoreFocus(before: Element | null, box: HTMLElement): void {
  if (
    before instanceof HTMLElement &&
    before.isConnected &&
    !box.contains(before)
  )
    before.focus();
}

/**
 * The question the agent asked the user. The choices are buttons: click one,
 * press its number (1-9), or move with the arrow keys and press Enter or Space;
 * when several may be chosen they toggle and Enter (or "send") sends them
 * together. Typing a free-form reply in the box still works.
 *
 * A question never takes the keyboard from someone who is typing: if the
 * message box has text in it, the question waits (a cue says so) until it is
 * clicked or tabbed to, so the digits of a message cannot answer it. Otherwise
 * the first choice (or the reply box, with no choices) is focused, and focus
 * goes back to where it was when the question closes.
 */
export function createAskUi(
  elements: {
    box: HTMLElement;
    question: HTMLElement;
    options: HTMLUListElement;
    answer: HTMLInputElement;
    send: HTMLButtonElement;
    /** The message box the user types steering and new messages in. */
    composer: HTMLInputElement;
  },
  sendMessage: (msg: Record<string, unknown>) => void,
  announce: (text: string) => void = () => {},
): { show(message: ServerMessage): void; hide(): void } {
  const { box, question, options, answer, composer } = elements;
  let choices: string[] = [];
  let multi = false;
  let active = 0;
  let before: Element | null = null;
  const selected = new Set<number>();
  const buttons: HTMLButtonElement[] = [];

  function hide(): void {
    const wasOpen = !box.classList.contains("hidden");
    box.classList.add("hidden");
    box.removeAttribute("data-waiting");
    question.textContent = "";
    options.textContent = "";
    buttons.length = 0;
    choices = [];
    selected.clear();
    answer.value = "";
    if (wasOpen) restoreFocus(before, box);
    before = null;
  }

  function reply(text: string): void {
    hide();
    sendMessage({ type: "ask_answer", text });
  }

  /** Send what the user has chosen or typed. */
  const submit = (): void =>
    reply(answerFrom(choices, selected, answer.value, multi));

  function highlight(index: number, focus = true): void {
    if (buttons.length === 0) return;
    active = (index + buttons.length) % buttons.length;
    buttons.forEach((button, i) =>
      button.classList.toggle("active", i === active),
    );
    if (focus) buttons[active]?.focus();
  }

  /** Choose a choice: it is the answer, or (several allowed) it toggles. */
  function pick(index: number): void {
    const choice = choices[index];
    if (choice === undefined) return;
    if (!multi) return reply(choice);
    if (!selected.delete(index)) selected.add(index);
    buttons[index]?.setAttribute("aria-pressed", String(selected.has(index)));
    buttons[index]?.classList.toggle("selected", selected.has(index));
    highlight(index);
  }

  /** Enter: send typed text if there is any; otherwise confirm the highlighted choice. */
  function confirm(): void {
    if (answer.value.trim() !== "" || (multi && selected.size > 0)) submit();
    else if (!multi && choices.length > 0) pick(active);
  }

  elements.send.addEventListener("click", submit);
  // Any way into the question (a click, Tab) ends its waiting.
  box.addEventListener("focusin", () => box.removeAttribute("data-waiting"));
  box.addEventListener("keydown", (event: KeyboardEvent) => {
    const effect = decideKey({
      key: event.key,
      modified: event.ctrlKey || event.metaKey || event.altKey,
      typing: event.target === answer,
      onBox: event.target === box,
      choiceCount: choices.length,
      multi,
      selectedCount: selected.size,
    });
    if (effect.type === "none") return;
    if (effect.type !== "focusInput") event.preventDefault();
    if (effect.type === "pick") pick(effect.index);
    else if (effect.type === "pickActive") pick(active);
    else if (effect.type === "move") highlight(active + effect.by);
    else if (effect.type === "confirm") confirm();
    else answer.focus();
  });
  // The browser also activates a focused button on Space's key-up: cancel it, Space was handled on key-down.
  box.addEventListener("keyup", (event: KeyboardEvent) => {
    if (event.key === " " && event.target !== answer) event.preventDefault();
  });

  return {
    hide,
    show(message) {
      hide();
      choices = message.options ?? [];
      multi = message.multiSelect === true;
      active = 0;
      question.textContent = message.question ?? "";
      buttons.push(...renderChoices(options, choices, multi, pick));
      box.classList.remove("hidden");
      announce(`Question: ${message.question ?? ""}`);
      const writing =
        document.activeElement === composer && composer.value.trim() !== "";
      before = document.activeElement;
      if (writing) {
        // Someone is typing: leave the keyboard alone and say a question is waiting.
        box.setAttribute("data-waiting", "true");
        highlight(0, false);
      } else if (buttons.length > 0) highlight(0);
      else answer.focus();
    },
  };
}
