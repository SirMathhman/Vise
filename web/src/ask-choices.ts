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

/** What a key press does while a question is open. */
export type AskEffect =
  | { type: "pick"; index: number }
  | { type: "pickActive" }
  | { type: "move"; by: 1 | -1 }
  | { type: "confirm" }
  | { type: "focusInput" }
  | { type: "none" };

/** What the decision needs to know about the key and the question. */
export interface AskKeyState {
  key: string;
  /** Ctrl, Cmd or Alt is held: a shortcut, never a reply. */
  modified: boolean;
  /** The key went to the reply box, where every character is part of the reply. */
  typing: boolean;
  /** The key went to the question's own box (nothing in it focused). */
  onBox: boolean;
  choiceCount: number;
  multi: boolean;
  selectedCount: number;
}

/**
 * What a key does: 1-9 choose the numbered choice, Space chooses the
 * highlighted one, the arrows move the highlight, Enter sends the typed reply or
 * confirms the choice (several allowed: sends what is ticked), and a letter
 * moves into the reply box. In the reply box, digits and Space are just text.
 */
export function decideKey(s: AskKeyState): AskEffect {
  if (!s.typing && /^[1-9]$/.test(s.key)) {
    const index = Number(s.key) - 1;
    if (index < s.choiceCount) return { type: "pick", index };
  }
  if (!s.typing && s.key === " " && s.choiceCount > 0) return { type: "pickActive" };
  if (s.choiceCount > 0 && (s.key === "ArrowDown" || s.key === "ArrowUp")) {
    return { type: "move", by: s.key === "ArrowDown" ? 1 : -1 };
  }
  if (s.key === "Enter" && (s.typing || s.onBox || (s.multi && s.selectedCount > 0))) {
    return { type: "confirm" };
  }
  if (!s.typing && !s.modified && s.key.length === 1) return { type: "focusInput" };
  return { type: "none" };
}
