import { answerFrom, askKey } from "./ask-choices.ts";
import type { ServerMessage } from "./server-message.ts";

/** A choice as a button with its number (keys 1-9 choose it); a toggle when several may be chosen. */
function choiceButton(choice: string, index: number, multi: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ask-option";
  if (multi) button.setAttribute("aria-pressed", "false");
  const key = document.createElement("span");
  key.className = "ask-key";
  key.textContent = index < 9 ? String(index + 1) : "·";
  button.append(key, document.createTextNode(choice));
  return button;
}

/**
 * The question the agent asked the user. The choices are buttons: click one,
 * press its number (1-9), or move with the arrow keys and press Enter. When
 * several may be chosen they toggle and Enter (or "send") sends them together.
 * Typing a free-form reply in the box still works (digits are then part of the
 * reply, and a letter pressed on a choice moves into the box), and with no
 * choices the box has the focus straight away. Space chooses the highlighted
 * choice; the browser's own button activation is cancelled so it cannot toggle
 * twice. With several allowed, Space toggles and Enter sends what is ticked.
 */
export function createAskUi(
  elements: {
    box: HTMLElement;
    question: HTMLElement;
    options: HTMLUListElement;
    answer: HTMLInputElement;
    send: HTMLButtonElement;
  },
  sendMessage: (msg: Record<string, unknown>) => void,
): { show(message: ServerMessage): void; hide(): void } {
  const { box, question, options, answer } = elements;
  let choices: string[] = [];
  let multi = false;
  let active = 0;
  const selected = new Set<number>();
  const buttons: HTMLButtonElement[] = [];

  function hide(): void {
    box.classList.add("hidden");
    question.textContent = "";
    options.textContent = "";
    buttons.length = 0;
    choices = [];
  }

  function reply(text: string): void {
    answer.value = "";
    hide();
    sendMessage({ type: "ask_answer", text });
  }

  /** Send what the user has chosen or typed. */
  const submit = (): void => reply(answerFrom(choices, selected, answer.value, multi));

  function highlight(index: number): void {
    if (buttons.length === 0) return;
    active = (index + buttons.length) % buttons.length;
    buttons.forEach((button, i) => button.classList.toggle("active", i === active));
    buttons[active]?.focus();
  }

  /** Choose a choice: it is the answer, or (several allowed) it toggles. */
  function pick(index: number): void {
    const choice = choices[index];
    if (choice === undefined) return;
    if (!multi) {
      reply(choice);
      return;
    }
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
  box.addEventListener("keydown", (event: KeyboardEvent) => {
    const typing = event.target === answer;
    const action = askKey(event.key, choices.length);
    if (action.type === "pick" && !typing) {
      event.preventDefault();
      pick(action.index);
    } else if (event.key === " " && !typing && choices.length > 0) {
      event.preventDefault();
      pick(active);
    } else if (action.type === "move" && choices.length > 0) {
      event.preventDefault();
      highlight(active + action.by);
    } else if (action.type === "enter" && (typing || event.target === box || (multi && selected.size > 0))) {
      event.preventDefault();
      confirm();
    } else if (!typing && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      answer.focus();
    }
  });

  box.addEventListener("keyup", (event: KeyboardEvent) => {
    if (event.key === " " && event.target !== answer) event.preventDefault();
  });

  return {
    hide,
    show(message) {
      choices = message.options ?? [];
      multi = message.multiSelect === true;
      selected.clear();
      buttons.length = 0;
      active = 0;
      question.textContent = message.question ?? "";
      options.textContent = "";
      choices.forEach((choice, index) => {
        const button = choiceButton(choice, index, multi);
        button.addEventListener("click", () => pick(index));
        const item = document.createElement("li");
        item.append(button);
        options.append(item);
        buttons.push(button);
      });
      box.setAttribute("tabindex", "-1");
      box.classList.remove("hidden");
      if (buttons.length > 0) highlight(0);
      else answer.focus();
    },
  };
}
