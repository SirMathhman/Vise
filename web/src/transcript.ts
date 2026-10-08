import { createLineModel } from "./chat-lines.ts";
import type { ChatLine, LineModel } from "./chat-lines.ts";
import { createFollower, nextFrame } from "./follow.ts";
import { createStreamRenderer, showMarkdown } from "./stream-render.ts";

export interface TranscriptView {
  addLine(cls: string, text: string): HTMLDivElement;
  appendAssistantToken(text: string): void;
  appendThinkingToken(text: string): void;
  /** `text` is the finished line (icon, name, detail); without it the line is just `tool: <name>`. */
  appendToolCall(name: string, depth?: number, text?: string): void;
  /** Append a subagent's streamed reply (a dimmed, indented block). */
  appendSubagentToken(text: string): void;
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

/** A reply still being written: its element and the text so far. */
interface Block {
  element: HTMLElement | null;
  raw: string;
}

/** Add `text` to a block, starting its element at the end of the log when it has none. */
function extend(
  log: HTMLElement,
  model: LineModel,
  block: Block,
  className: string,
  text: string,
): void {
  if (!block.element) {
    block.element = document.createElement("div");
    block.element.className = `line ${className}`;
    log.appendChild(block.element);
    model.add(className, "", block.element);
    block.raw = "";
  }
  block.raw += text;
}

/** A streamed reply ended: show it whole, record what it says, and let the next one start a new line. */
function finishBlock(
  model: LineModel,
  block: Block,
  renderHtml?: (markdown: string) => string,
): void {
  if (!block.element) return;
  showMarkdown(block.element, block.raw, renderHtml);
  model.settle(block.element, block.raw);
  block.element = null;
}

/** A new thinking line: collapsed, and operable as a button. */
function startThinking(addLine: (cls: string, text: string) => HTMLElement): HTMLElement {
  const line = addLine("thinking", "");
  setThinkingState(line, false);
  return line;
}

/** Take a transient line out of the log and out of the record of the conversation. */
function removeRecorded(model: LineModel, element: HTMLElement): void {
  model.remove(element);
  element.remove();
}

/** A thinking line ended: it collapses again and its text is final. */
function finishThinking(model: LineModel, line: HTMLElement | null): void {
  if (!line) return;
  line.className = line.className.replace(/ open$/, "");
  setThinkingState(line, false);
  model.settle(line, line.textContent ?? "");
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
  const assistant: Block = { element: null, raw: "" };
  const subagent: Block = { element: null, raw: "" };
  let activeThinking: HTMLElement | null = null;
  const model = createLineModel();
  const stream = createStreamRenderer(renderHtml);
  const { follow, jump } = createFollower(log, onPinned);
  let renderQueued = false;

  // Thinking lines start collapsed and collapse again when the thinking ends.
  function endThinking(): void {
    finishThinking(model, activeThinking);
    activeThinking = null;
  }

  enableThinkingToggle(log);
  function addLine(cls: string, text: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.textContent = text;
    log.appendChild(div);
    model.add(cls, text, div);
    follow();
    return div;
  }

  /** Render what streamed in since the last frame (token rates are far above frame rates). */
  function renderOpen(): void {
    renderQueued = false;
    if (subagent.element) showMarkdown(subagent.element, subagent.raw, renderHtml);
    if (assistant.element) stream.render(assistant.element, assistant.raw);
    follow();
  }

  function queueRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    nextFrame(renderOpen);
  }

  function appendSubagentToken(text: string): void {
    flushAssistant(true);
    endThinking();
    extend(log, model, subagent, "assistant subagent", text);
    queueRender();
  }

  // `keepSubagent` lets a subagent block keep growing across its tokens.
  function flushAssistant(keepSubagent = false): void {
    if (!keepSubagent) finishBlock(model, subagent, renderHtml);
    if (!assistant.element) return;
    // The whole reply is rendered once more, so the parts rendered separately while it streamed join up.
    finishBlock(model, assistant, renderHtml);
    stream.reset();
    follow();
  }

  function appendAssistantToken(text: string): void {
    endThinking();
    extend(log, model, assistant, "assistant", text);
    queueRender();
  }

  function appendThinkingToken(text: string): void {
    if (!text) return;
    flushAssistant();
    if (!activeThinking) activeThinking = startThinking(addLine);
    activeThinking.textContent += text;
    follow();
  }

  return {
    addLine,
    appendAssistantToken,
    appendSubagentToken,
    appendThinkingToken,
    appendToolCall(name: string, depth?: number, text?: string): void {
      flushAssistant();
      endThinking();
      addLine(
        burstActive ? "tool burst" : "tool",
        `${text ?? `tool: ${name}`}${depth ? " (subagent)" : ""}`,
      );
    },
    setBurst(active: boolean): void {
      if (active && !burstActive) {
        flushAssistant();
        endThinking();
        addLine("burst", "⚡ burst: running the plan without thinking");
      }
      burstActive = active;
    },
    finishThinking: endThinking,
    flushAssistant,
    clear(): void {
      log.textContent = "";
      assistant.element = null;
      subagent.element = null;
      stream.reset();
      model.clear();
      endThinking();
      jump();
    },
    scrollToBottom: jump,
    lines: () => model.lines,
    removeLine: (element) => removeRecorded(model, element),
  };
}
