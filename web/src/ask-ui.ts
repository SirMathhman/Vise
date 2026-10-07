import type { ServerMessage } from "./server-message.ts";

/** The question the agent asked the user, with its choices, and the box the answer goes in. */
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

  function hide(): void {
    box.classList.add("hidden");
    question.textContent = "";
    options.textContent = "";
  }

  function submit(): void {
    const text = answer.value;
    answer.value = "";
    hide();
    sendMessage({ type: "ask_answer", text });
  }

  elements.send.addEventListener("click", submit);
  answer.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });

  return {
    hide,
    show(message) {
      question.textContent = message.question ?? "";
      options.textContent = "";
      (message.options ?? []).forEach((option, index) => {
        const item = document.createElement("li");
        item.textContent = `${index + 1}. ${option}`;
        options.appendChild(item);
      });
      box.classList.remove("hidden");
      answer.focus();
    },
  };
}
