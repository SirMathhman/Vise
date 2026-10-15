/** Mark a thinking line as a button that opens and closes it; while closed its text is hidden from assistive technology too. */
function setThinkingState(line: HTMLElement, open: boolean): void {
  line.setAttribute?.("role", "button");
  line.setAttribute?.("tabindex", "0");
  line.setAttribute?.("aria-expanded", String(open));
  if (open) line.removeAttribute?.("aria-label");
  else line.setAttribute?.("aria-label", "Thinking (collapsed)");
}

/**
 * Press (or Enter, or Space) on a thinking line to open or close it. While the
 * model streams, the log keeps scrolling and growing under the pointer, so a
 * press and its release can land on different elements and the browser then
 * sends no click to the line: the press itself does the toggle, and the click
 * that follows it is ignored. A click on its own (no press before it) still toggles.
 */
export function enableThinkingToggle(log: HTMLElement): void {
  let pressed = false;
  const toggle = (event: Event): void => {
    const line = (event.target as HTMLElement | null)?.closest?.(".line.thinking");
    if (!(line instanceof HTMLElement)) return;
    const open = !line.className.endsWith(" open");
    line.className = open ? `${line.className} open` : line.className.replace(/ open$/, "");
    setThinkingState(line, open);
  };
  log.addEventListener?.("pointerdown", (event) => {
    if ((event as PointerEvent).button !== 0) return;
    const line = (event.target as HTMLElement | null)?.closest?.(".line.thinking");
    if (!line) return;
    pressed = true;
    toggle(event);
  });
  log.addEventListener?.("click", (event) => {
    if (pressed) {
      pressed = false;
      return;
    }
    toggle(event);
  });
  log.addEventListener?.("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      toggle(event);
    }
  });
}

/** The header's running count, shown even while the text is collapsed: " · 123 tokens". */
export function thinkingMeta(tokens: number): string {
  return ` · ${tokens.toLocaleString("en-US")} token${tokens === 1 ? "" : "s"}`;
}

export interface ThinkingDeps {
  addLine(cls: string, text: string): HTMLElement;
  /** Record the finished line's text in the conversation model. */
  settle(line: HTMLElement, text: string): void;
  follow(): void;
  /** Sanitized markdown to HTML; without it the text stays verbatim. */
  renderHtml?: (markdown: string) => string;
}

/**
 * The model's thinking as one collapsed line per stretch of thinking: the header
 * counts the tokens as they arrive, the text streams in verbatim (so a long
 * stretch stays cheap), and when the stretch ends it is rendered as markdown.
 */
export function createThinking(deps: ThinkingDeps): {
  append(text: string): void;
  end(): void;
  active(): boolean;
} {
  let line: HTMLElement | null = null;
  let raw = "";
  let tokens = 0;
  /** The line's one text node, grown in place: replacing it on every token would pull the text out from under a press on it. */
  let text: Text | null = null;

  return {
    active: () => line !== null,
    append(piece) {
      if (!line) {
        line = deps.addLine("thinking", "");
        setThinkingState(line, false);
        raw = "";
        tokens = 0;
        text = null;
        if (typeof document !== "undefined" && typeof line.append === "function") {
          text = document.createTextNode("");
          line.append(text);
        }
      }
      raw += piece;
      tokens += 1;
      if (text) text.appendData(piece);
      else line.textContent += piece;
      line.setAttribute?.("data-meta", thinkingMeta(tokens));
      deps.follow();
    },
    end() {
      if (!line) return;
      line.className = line.className.replace(/ open$/, "");
      setThinkingState(line, false);
      if (deps.renderHtml && raw.trim() !== "") {
        line.innerHTML = deps.renderHtml(raw);
        line.className = `${line.className} rendered`;
      }
      deps.settle(line, raw);
      line = null;
    },
  };
}
