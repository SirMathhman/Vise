/**
 * One line of the conversation as data: what kind it is, what it says, and the
 * element currently showing it. The data is the record of the conversation and
 * the element is only its present rendering, so a view that keeps just the
 * newest lines mounted (or loads older ones from the server) can drop and
 * rebuild elements without losing anything.
 */
export interface ChatLine {
  /** Counts up from 1 in the order lines were added; never reused. */
  readonly id: number;
  /** The line's classes after `line ` (`user`, `tool burst`, `assistant subagent`...). */
  readonly cls: string;
  /** The text as written (markdown for a reply), kept up to date when a streamed line ends. */
  text: string;
  /** The element showing it, or null once it is no longer mounted. */
  element: HTMLElement | null;
}

export interface LineModel {
  readonly lines: readonly ChatLine[];
  add(cls: string, text: string, element: HTMLElement): ChatLine;
  /** A streamed line ended: record what it finally says. */
  settle(element: HTMLElement, text: string): void;
  /** A transient line (a progress bar) went away: it is not conversation content, so its record goes too. */
  remove(element: HTMLElement): void;
  clear(): void;
}

export function createLineModel(): LineModel {
  const lines: ChatLine[] = [];
  const byElement = new WeakMap<HTMLElement, ChatLine>();
  let nextId = 1;
  return {
    lines,
    add(cls, text, element) {
      const line: ChatLine = { id: nextId++, cls, text, element };
      lines.push(line);
      byElement.set(element, line);
      return line;
    },
    settle(element, text) {
      const line = byElement.get(element);
      if (line) line.text = text;
    },
    remove(element) {
      const line = byElement.get(element);
      if (line) lines.splice(lines.indexOf(line), 1);
    },
    clear() {
      lines.length = 0;
    },
  };
}
