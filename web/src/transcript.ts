import { createBoxes } from "./boxes.ts";
import { createLineModel } from "./chat-lines.ts";
import type { ChatLine } from "./chat-lines.ts";
import { createFollower } from "./follow.ts";
import { createReplies } from "./replies.ts";

export interface TranscriptView {
  addLine(cls: string, text: string): HTMLDivElement;
  appendAssistantToken(text: string): void;
  appendThinkingToken(text: string): void;
  /** `text` is the finished line (icon, name, detail); without it the line is just `tool: <name>`. */
  appendToolCall(name: string, depth?: number, text?: string): void;
  /** What the last tool call came to ("12 matches"), shown at the end of its line. */
  appendToolResult(text: string): void;
  /** Append a subagent's streamed reply (a dimmed, indented block). */
  appendSubagentToken(text: string): void;
  /** A subagent starts: a box titled `title` holds its work (nested inside the open box, if any). */
  beginBox(title: string): void;
  /** The innermost subagent finished: its box collapses. */
  endBox(): void;
  /** Collapse every open box (the turn ended). */
  endBoxes(): void;
  /** Mark subsequent tool calls as part of a burst (no thinking between). */
  setBurst(active: boolean): void;
  finishThinking(): void;
  flushAssistant(): void;
  clear(): void;
  /** Jump to the newest line and follow new ones again. */
  scrollToBottom(): void;
  /** Take a transient line (a progress bar) out of the log and out of the record of the conversation. */
  removeLine(element: HTMLElement): void;
  /** The conversation as data (kind, text, id), in order; the elements only show it. */
  lines(): readonly ChatLine[];
}

/** Mark a thinking line as a button that opens and closes it; while closed its text is hidden from assistive technology too. */
function setThinkingState(line: HTMLElement, open: boolean): void {
  line.setAttribute?.("role", "button");
  line.setAttribute?.("tabindex", "0");
  line.setAttribute?.("aria-expanded", String(open));
  if (open) line.removeAttribute?.("aria-label");
  else line.setAttribute?.("aria-label", "Thinking (collapsed)");
}

/** Click (or Enter, or Space) on a thinking line to open or close it. */
function enableThinkingToggle(log: HTMLElement): void {
  const toggle = (event: Event): void => {
    const line = (event.target as HTMLElement | null)?.closest?.(".line.thinking");
    if (!(line instanceof HTMLElement)) return;
    const open = !line.className.endsWith(" open");
    line.className = open ? `${line.className} open` : line.className.replace(/ open$/, "");
    setThinkingState(line, open);
  };
  log.addEventListener?.("click", toggle);
  log.addEventListener?.("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      toggle(event);
    }
  });
}

/**
 * `renderHtml`, when given, turns assistant markdown into sanitized HTML; when
 * omitted, assistant text is shown verbatim. `onPinned` hears whether the log is
 * following the newest line: new lines scroll into view only while it is, so
 * reading older ones is never interrupted.
 */
export function createTranscript(
  log: HTMLElement,
  renderHtml?: (markdown: string) => string,
  onPinned?: (pinned: boolean) => void,
): TranscriptView {
  let burstActive = false;
  let activeThinking: HTMLElement | null = null;
  let lastTool: HTMLElement | null = null;
  const model = createLineModel();
  const boxes = createBoxes(log);
  const { follow, jump } = createFollower(log, onPinned);
  const replies = createReplies({
    container: boxes.container,
    model,
    renderHtml,
    follow,
    endThinking: () => endThinking(),
  });

  // Thinking lines start collapsed, and collapse again when the thinking ends.
  function endThinking(): void {
    if (activeThinking) {
      activeThinking.className = activeThinking.className.replace(/ open$/, "");
      setThinkingState(activeThinking, false);
      model.settle(activeThinking, activeThinking.textContent ?? "");
    }
    activeThinking = null;
  }

  enableThinkingToggle(log);
  function addLine(cls: string, text: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.textContent = text;
    boxes.container().appendChild(div);
    model.add(cls, text, div);
    follow();
    return div;
  }

  /** Whatever was streaming or thinking ends before an event of another kind starts. */
  function settle(): void {
    replies.flush();
    endThinking();
  }

  return {
    addLine,
    appendAssistantToken: replies.appendAssistant,
    appendSubagentToken: replies.appendSubagent,
    appendThinkingToken(text: string): void {
      if (!text) return;
      replies.flush();
      if (!activeThinking) {
        activeThinking = addLine("thinking", "");
        setThinkingState(activeThinking, false);
      }
      activeThinking.textContent += text;
      follow();
    },
    appendToolCall(name: string, depth?: number, text?: string): void {
      settle();
      lastTool = addLine(
        burstActive ? "tool burst" : "tool",
        `${text ?? `tool: ${name}`}${depth ? " (subagent)" : ""}`,
      );
    },
    appendToolResult(text: string): void {
      if (!lastTool) return;
      lastTool.textContent = `${lastTool.textContent ?? ""} → ${text}`;
      model.settle(lastTool, lastTool.textContent);
    },
    beginBox(title: string): void { settle(); boxes.begin(title); follow(); },
    endBox(): void { settle(); boxes.end(); },
    endBoxes(): void { settle(); boxes.endAll(); },
    setBurst(active: boolean): void {
      if (active && !burstActive) {
        settle();
        addLine("burst", "⚡ burst: running the plan without thinking");
      }
      burstActive = active;
    },
    finishThinking: endThinking,
    flushAssistant: () => replies.flush(),
    clear(): void {
      log.textContent = "";
      replies.reset();
      boxes.reset();
      model.clear();
      endThinking();
      lastTool = null;
      jump();
    },
    scrollToBottom: jump,
    lines: () => model.lines,
    removeLine: (element) => {
      model.remove(element);
      element.remove();
    },
  };
}
