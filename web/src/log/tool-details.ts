/**
 * A tool line that opens to show what the agent sent and what came back: the
 * line itself is the toggle (click, Enter or Space), and the details are a
 * block just below it, built when first opened. The line's own text is left
 * alone, so the transcript can still append the result's summary to it.
 */
export function createToolDetails(): {
  /** A tool call was shown as `line`; `args` is what the agent sent (pretty JSON). */
  attach(line: HTMLElement, args: string | undefined): void;
  /** The last call's full result arrived. */
  result(text: string | undefined): void;
} {
  const details = new WeakMap<HTMLElement, { args?: string; result?: string; block?: HTMLElement }>();
  let last: HTMLElement | null = null;

  function render(line: HTMLElement): void {
    const info = details.get(line);
    if (!info) return;
    const block = info.block ?? document.createElement("div");
    info.block = block;
    block.className = "tool-detail";
    block.textContent = "";
    const part = (label: string, text: string | undefined): void => {
      if (!text) return;
      const head = block.appendChild(document.createElement("div"));
      head.className = "tool-detail-label";
      head.textContent = label;
      block.appendChild(document.createElement("pre")).textContent = text;
    };
    part("Arguments", info.args);
    part("Result", info.result ?? "(no result yet)");
    if (!block.isConnected) line.after(block);
  }

  function toggle(line: HTMLElement): void {
    const open = line.getAttribute("aria-expanded") !== "true";
    line.setAttribute("aria-expanded", String(open));
    if (open) render(line);
    else details.get(line)?.block?.remove();
  }

  return {
    attach(line, args) {
      details.set(line, { args });
      last = line;
      line.classList.add("expandable");
      line.tabIndex = 0;
      line.setAttribute("role", "button");
      line.setAttribute("aria-expanded", "false");
      line.addEventListener("click", (event) => {
        // A selection inside the line is for copying, not for opening it.
        if (!window.getSelection()?.isCollapsed) return;
        event.preventDefault();
        toggle(line);
      });
      line.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle(line);
      });
    },
    result(text) {
      const info = last ? details.get(last) : undefined;
      if (!info || !last) return;
      info.result = text;
      if (last.getAttribute("aria-expanded") === "true") render(last);
    },
  };
}
