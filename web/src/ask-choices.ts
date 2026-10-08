/**
 * What the user's reply to a question is. With choices and a single answer it
 * is the typed text; with several allowed it is the ticked choices (in the
 * order they were offered) followed by anything typed, separated by commas.
 */
export function answerFrom(
  choices: readonly string[],
  selected: ReadonlySet<number>,
  typed: string,
  multi: boolean,
): string {
  const text = typed.trim();
  if (!multi) return text;
  const picked = [...selected]
    .sort((a, b) => a - b)
    .map((index) => choices[index])
    .filter((choice): choice is string => choice !== undefined);
  return [...picked, ...(text ? [text] : [])].join(", ");
}

/** What a key does while a question with choices is open. */
export type AskKey =
  | { type: "pick"; index: number }
  | { type: "move"; by: 1 | -1 }
  | { type: "enter" }
  | { type: "none" };

/** Keys 1-9 choose the numbered choice, the arrows move the highlight, Enter confirms it. */
export function askKey(key: string, choiceCount: number): AskKey {
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    return index < choiceCount ? { type: "pick", index } : { type: "none" };
  }
  if (key === "ArrowDown") return { type: "move", by: 1 };
  if (key === "ArrowUp") return { type: "move", by: -1 };
  if (key === "Enter") return { type: "enter" };
  return { type: "none" };
}
