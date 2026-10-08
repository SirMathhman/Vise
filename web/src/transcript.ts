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
}

/** Click a thinking line to open or close it. */
function enableThinkingToggle(log: HTMLElement): void {
  log.addEventListener?.("click", (event) => {
    const line = (event.target as HTMLElement | null)?.closest?.(
      ".line.thinking",
    );
    if (!(line instanceof HTMLElement)) return;
    line.className = line.className.endsWith(" open")
      ? line.className.replace(/ open$/, "")
      : `${line.className} open`;
  });
}

/** A reply still being written: its element and the text so far. */
interface Block {
  element: HTMLElement | null;
  raw: string;
}

/** Add `text` to a block, starting its element at the end of the log when it has none. */
function extend(log: HTMLElement, block: Block, className: string, text: string): void {
  if (!block.element) {
    block.element = document.createElement("div");
    block.element.className = className;
    log.appendChild(block.element);
    block.raw = "";
  }
  block.raw += text;
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
  const stream = createStreamRenderer(renderHtml);
  const { follow, jump } = createFollower(log, onPinned);
  let renderQueued = false;

  // Thinking lines start collapsed and collapse again when the thinking ends.
  function endThinking(): void {
    if (activeThinking) activeThinking.className = activeThinking.className.replace(/ open$/, "");
    activeThinking = null;
  }

  enableThinkingToggle(log);

  function addLine(cls: string, text: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.textContent = text;
    log.appendChild(div);
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
    extend(log, subagent, "line assistant subagent", text);
    queueRender();
  }

  // `keepSubagent` lets a subagent block keep growing across its tokens.
  function flushAssistant(keepSubagent = false): void {
    if (!keepSubagent && subagent.element) {
      showMarkdown(subagent.element, subagent.raw, renderHtml);
      subagent.element = null;
    }
    if (!assistant.element) return;
    // The whole reply is rendered once more, so the parts rendered separately while it streamed join up.
    showMarkdown(assistant.element, assistant.raw, renderHtml);
    assistant.element = null;
    stream.reset();
    follow();
  }

  function appendAssistantToken(text: string): void {
    endThinking();
    extend(log, assistant, "line assistant", text);
    queueRender();
  }

  function appendThinkingToken(text: string): void {
    if (!text) return;
    flushAssistant();
    if (!activeThinking) activeThinking = addLine("thinking", "");
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
      const line = addLine(
        "tool",
        `${text ?? `tool: ${name}`}${depth ? " (subagent)" : ""}`,
      );
      if (burstActive) line.className += " burst";
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
      endThinking();
      jump();
    },
    scrollToBottom: jump,
  };
}
