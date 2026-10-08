/**
 * Nested boxes in the log. A subagent's work (its tool calls, what it says) goes
 * into a box opened by its "Run helper agent" line, and a subagent it starts
 * opens a box inside that one. A box collapses when its subagent finishes, so
 * the log shows the result and not the work, which stays one click away.
 */
export interface Boxes {
  /** Where the next line goes: the innermost open box, or the log. */
  container(): HTMLElement;
  /** Open a box titled `title` inside the current container. */
  begin(title: string): void;
  /** The innermost open box is done: collapse it. */
  end(): void;
  /** Show `text` (its context fill) at the bottom of the innermost open box, or of the last one that closed. */
  meta(text: string): void;
  /** Collapse every open box (the turn ended without closing them). */
  endAll(): void;
  /** Forget the boxes (the log was cleared). */
  reset(): void;
}

export function createBoxes(log: HTMLElement): Boxes {
  const open: { details: HTMLDetailsElement; body: HTMLElement; foot: HTMLElement }[] = [];
  let lastFoot: HTMLElement | undefined;
  const boxes: Boxes = {
    container: () => open[open.length - 1]?.body ?? log,
    begin(title) {
      const details = document.createElement("details");
      details.className = "box";
      details.open = true;
      const head = document.createElement("summary");
      head.className = "line tool box-title";
      head.textContent = title;
      const body = document.createElement("div");
      body.className = "box-body";
      const foot = document.createElement("div");
      foot.className = "box-context";
      details.append(head, body, foot);
      boxes.container().appendChild(details);
      open.push({ details, body, foot });
      lastFoot = foot;
    },
    end() {
      const box = open.pop();
      if (!box) return;
      box.details.open = false;
      box.details.classList.add("done");
    },
    meta(text) {
      const foot = open[open.length - 1]?.foot ?? lastFoot;
      if (foot) foot.textContent = text;
    },
    endAll() {
      while (open.length > 0) boxes.end();
    },
    reset() {
      open.length = 0;
    },
  };
  return boxes;
}
