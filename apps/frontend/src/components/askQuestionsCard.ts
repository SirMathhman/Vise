/** One question the model asks the user. */
export interface AskQuestion {
  question: string;
  options?: string[];
  multiSelect?: boolean;
}

/** A handle to a live question card, so the caller can tear it down. */
export interface AskCardHandle {
  /**
   * Mark the card as resolved without an answer, remove it from the DOM,
   * and return the "not answered" result string for the given questions.
   */
  resolveNotAnswered: (questions: AskQuestion[]) => string;
}

/**
 * Render an interactive ask_questions card into `container`. The card shows
 * one block per question, each with optional predefined answer options
 * (checkbox when multi_select, radio otherwise) and a free-text input. An
 * Answer button collects the answers and calls `onAnswer` with the
 * model-readable result string. The returned handle lets the caller resolve
 * the card as "not answered" and remove it when the pending question is
 * dropped (conversation switched, a new turn started, etc.).
 *
 * The card is ephemeral: it is not part of the persisted conversation
 * history, only the tool result (the answer) is. See messageView.ts's
 * appendQuestion and llm.ts's askQuestions.
 */
export function renderAskQuestionsCard(
  container: HTMLElement,
  questions: AskQuestion[],
  onAnswer: (result: string) => void
): AskCardHandle {
  const card = document.createElement("div");
  card.className = "llm-ask";
  const label = document.createElement("span");
  label.className = "llm-ask-label";
  label.textContent = "Questions";
  card.append(label);

  const answers: string[] = questions.map(() => "");
  const inputs: HTMLTextAreaElement[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const block = document.createElement("div");
    block.className = "llm-ask-question";
    const text = document.createElement("div");
    text.className = "llm-ask-text";
    text.textContent = q.question;
    block.append(text);

    if (q.options && q.options.length > 0) {
      const opts = document.createElement("div");
      opts.className = "llm-ask-options";
      q.options.forEach((opt) => {
        const optEl = document.createElement("label");
        optEl.className = "llm-ask-option";
        const cb = document.createElement("input");
        cb.type = q.multiSelect ? "checkbox" : "radio";
        cb.name = `ask-q-${i}`;
        cb.value = opt;
        cb.addEventListener("change", () => {
          updateAnswer(i);
        });
        optEl.append(cb, document.createTextNode(opt));
        opts.append(optEl);
      });
      block.append(opts);
    }

    const input = document.createElement("textarea");
    input.className = "llm-ask-input";
    input.rows = q.options ? 1 : 2;
    input.placeholder = "Your answer…";
    input.addEventListener("input", () => {
      updateAnswer(i);
    });
    inputs.push(input);
    block.append(input);
    card.append(block);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "llm-ask-answer";
  btn.textContent = "Answer";
  btn.disabled = true;

  function updateAnswer(i: number): void {
    const q = questions[i];
    const selected = q.options
      ? Array.from(
          card.querySelectorAll<HTMLInputElement>(
            `input[name="ask-q-${i}"]:checked`
          )
        )
          .map((el) => el.value)
          .join(", ")
      : "";
    const free = inputs[i].value.trim();
    answers[i] = [selected, free].filter(Boolean).join(" · ");
    btn.disabled = !answers.some((a) => a !== "");
  }

  btn.addEventListener("click", () => {
    const result = formatAskQuestionsResult(questions, answers);
    onAnswer(result);
    card.remove();
  });
  card.append(btn);

  container.append(card);
  btn.focus();

  return {
    resolveNotAnswered(qs: AskQuestion[]): string {
      const result = notAnsweredResult(qs);
      const note = document.createElement("span");
      note.className = "llm-ask-resolved-note";
      note.textContent = "Not answered (turn ended).";
      card.append(note);
      card.remove();
      return result;
    },
  };
}

/**
 * Format the user's answers as a model-readable result string: one line per
 * question, "Q<index>: <answer>", so the model can tell which answer
 * corresponds to which question.
 */
export function formatAskQuestionsResult(
  questions: AskQuestion[],
  answers: string[]
): string {
  return questions
    .map((_q, i) => `Q${i + 1}: ${answers[i] || "(no answer)"}`)
    .join("\n");
}

/** The result string used when a pending question is resolved without an answer. */
export function notAnsweredResult(questions: AskQuestion[]): string {
  return questions.map((_q, i) => `Q${i + 1}: (not answered)`).join("\n");
}
