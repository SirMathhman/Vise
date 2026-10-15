import { createBoxes } from "./boxes.ts";
import { buildCollapsed } from "./collapsed.ts";
import { createLineModel } from "./chat-lines.ts";
import type { ChatLine } from "./chat-lines.ts";
import { createFollower } from "./follow.ts";
import { createReplies } from "./replies.ts";
import { createThinking, enableThinkingToggle } from "./thinking.ts";

export interface TranscriptView {
  addLine(cls: string, text: string): HTMLDivElement;
  appendAssistantToken(text: string): void;
  appendThinkingToken(text: string): void;
  /** `text` is the finished line (icon, name, detail); without it the line is just `tool: <name>`. */
  appendToolCall(name: string, depth?: number, text?: string): HTMLElement;
  /** What the last tool call came to ("12 matches"), shown at the end of its line. */
  appendToolResult(text: string): void;
  /** Append a subagent's streamed reply (a dimmed, indented block). */
  appendSubagentToken(text: string): void;
  /** A subagent starts: a box titled `title` holds its work (nested inside the open box, if any). */
  beginBox(title: string): void;
  /** The innermost subagent finished: its box collapses. */
  endBox(): void;
  /** Label the innermost subagent box (its context fill). */
  setBoxMeta(text: string): void;
  /** Collapse every open box (the turn ended). */
  endBoxes(): void;
  /** A line whose `detail` stays folded away until opened, under the visible `title`. */
  addCollapsed(cls: string, title: string, detail: string): HTMLElement;
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
  const thinking = createThinking({
    addLine: (cls, text) => addLine(cls, text),
    settle: (line, text) => model.settle(line, text),
    follow,
    renderHtml,
  });
  const endThinking = thinking.end;

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

  function addCollapsed(cls: string, title: string, detail: string): HTMLElement {
    const box = buildCollapsed(cls, title, detail);
    boxes.container().appendChild(box);
    model.add(cls, detail ? `${title} — ${detail}` : title, box);
    follow();
    return box;
  }

  return {
    addLine,
    addCollapsed,
    appendAssistantToken: replies.appendAssistant,
    appendSubagentToken: replies.appendSubagent,
    appendThinkingToken(text: string): void {
      if (!text) return;
      replies.flush();
      thinking.append(text);
    },
    appendToolCall(name: string, depth?: number, text?: string): HTMLElement {
      settle();
      lastTool = addLine(
        burstActive ? "tool burst" : "tool",
        `${text ?? `tool: ${name}`}${depth ? " (subagent)" : ""}`,
      );
      return lastTool;
    },
    appendToolResult(text: string): void {
      if (!lastTool) return;
      lastTool.textContent = `${lastTool.textContent ?? ""} → ${text}`;
      model.settle(lastTool, lastTool.textContent);
    },
    beginBox(title: string): void {
      settle();
      boxes.begin(title);
      follow();
    },
    endBox(): void {
      settle();
      boxes.end();
    },
    setBoxMeta: boxes.meta,
    endBoxes(): void {
      settle();
      boxes.endAll();
    },
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
      thinking.end();
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
