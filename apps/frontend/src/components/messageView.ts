import type { LlmToolCall } from "../api/client.js";
import type { ChatMessage } from "./conversations.js";

/**
 * A virtualized view of a chat conversation's messages. It keeps the DOM
 * bounded no matter how long the conversation grows: only the blocks visible
 * in the viewport (plus a small buffer) are in the DOM, positioned absolutely
 * inside a spacer that is as tall as the full conversation. Scrolling back
 * through the whole history stays smooth because the number of live nodes
 * never grows past what fits on screen.
 *
 * The view is a thin, stateless-ish layer over the store's append-only
 * message list: the controller pushes the current messages (or appends single
 * blocks while a turn streams) and the view re-lays itself out. Nothing here
 * talks to the network; it only renders.
 */

/** One step recorded inside a subagent's own tool-calling loop. */
export interface SubagentStep {
  kind: "tool-call" | "tool-result";
  text: string;
}

/** One rendered block. A single chat message expands into one or more of these. */
type VisualItem =
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | { kind: "tool-call"; label: string }
  | { kind: "tool-result"; text: string }
  | { kind: "compaction" }
  | { kind: "subagent"; task: string; steps: SubagentStep[]; result: string };

/** Vertical gap applied after each block, mirroring the pre-wrap margin rhythm. */
const GAP = 10;
/** Extra rows rendered above/below the viewport so fast scrolls stay filled. */
const BUFFER = 4;
/** Height assumed for a block before it is measured (keeps jumps small). */
const ESTIMATED = 48;
/** Max layout passes to chase a measured-height change before settling. */
const MAX_PASSES = 3;

/** Format a tool call as its display label: `name(args)`. */
export function toolCallLabel(tc: LlmToolCall): string {
  return `${tc.function.name}(${tc.function.arguments})`;
}

/** Expand one chat message into the visual blocks it should render as. */
function expandMessage(m: ChatMessage): VisualItem[] {
  if (m.compaction) return [{ kind: "compaction" }];
  if (m.role === "tool")
    return [{ kind: "tool-result", text: m.content ?? "" }];
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    const items: VisualItem[] = m.tool_calls.map((tc) => ({
      kind: "tool-call",
      label: toolCallLabel(tc),
    }));
    if (m.content) {
      items.push({ kind: "message", role: "assistant", content: m.content });
    }
    return items;
  }
  if (m.role === "user" || m.role === "assistant") {
    return [{ kind: "message", role: m.role, content: m.content ?? "" }];
  }
  return [];
}

/** Expand a full message list into visual blocks, in order. */
function expandMessages(messages: ChatMessage[]): VisualItem[] {
  const items: VisualItem[] = [];
  for (const m of messages) items.push(...expandMessage(m));
  return items;
}

/** Build the DOM block for a single visual item. */
function renderItemDom(item: VisualItem): HTMLElement {
  switch (item.kind) {
    case "compaction": {
      const note = document.createElement("div");
      note.className = "llm-compaction";
      note.textContent = "— conversation compacted —";
      return note;
    }
    case "tool-call": {
      const block = document.createElement("div");
      block.className = "llm-tool";
      const label = document.createElement("span");
      label.className = "llm-tool-label";
      label.textContent = item.label;
      block.append(label);
      return block;
    }
    case "tool-result": {
      const block = document.createElement("div");
      block.className = "llm-tool-result";
      block.textContent = item.text;
      return block;
    }
    case "message": {
      const block = document.createElement("div");
      block.className = `llm-msg llm-msg-${item.role}`;
      const who = document.createElement("span");
      who.className = "llm-msg-role";
      who.textContent = item.role === "user" ? "You" : "Model";
      const text = document.createElement("span");
      text.className = "llm-msg-text";
      text.textContent = item.content;
      block.append(who, text);
      return block;
    }
    case "subagent":
      return renderSubagentDom(item);
  }
}

/**
 * Render a completed subagent run as a collapsed <details> block: its task in
 * the summary, its own tool-call/tool-result trace inside, closed out by its
 * final result. Collapsed by default so a delegated sub-task doesn't dominate
 * the main transcript.
 */
function renderSubagentDom(item: {
  task: string;
  steps: SubagentStep[];
  result: string;
}): HTMLElement {
  const details = document.createElement("details");
  details.className = "llm-subagent";
  const summary = document.createElement("summary");
  summary.className = "llm-subagent-summary";
  summary.textContent = `Subagent: ${item.task}`;
  details.append(summary);

  const body = document.createElement("div");
  body.className = "llm-subagent-body";
  for (const step of item.steps) {
    const stepEl = document.createElement("div");
    if (step.kind === "tool-call") {
      stepEl.className = "llm-tool";
      const label = document.createElement("span");
      label.className = "llm-tool-label";
      label.textContent = step.text;
      stepEl.append(label);
    } else {
      stepEl.className = "llm-tool-result";
      stepEl.textContent = step.text;
    }
    body.append(stepEl);
  }
  const result = document.createElement("div");
  result.className = "llm-subagent-result";
  result.textContent = item.result;
  body.append(result);
  details.append(body);
  return details;
}

/**
 * The scroll container's child that holds the conversation. It is as tall as
 * the full (virtualized) conversation; visible blocks are positioned
 * absolutely inside it by index, so the spacer preserves the total scroll
 * height while only a handful of nodes are live.
 */
class VirtualList {
  private content: HTMLElement;
  private heights: number[] = [];
  private nodes = new Map<number, HTMLElement>();
  private raf = 0;
  private renderItem: (index: number, item: VisualItem) => HTMLElement;
  private getItems: () => VisualItem[];
  private scroll: HTMLElement;

  constructor(
    scroll: HTMLElement,
    renderItem: (index: number, item: VisualItem) => HTMLElement,
    getItems: () => VisualItem[]
  ) {
    this.scroll = scroll;
    this.renderItem = renderItem;
    this.getItems = getItems;
    this.content = document.createElement("div");
    this.content.className = "llm-virtual";
    scroll.append(this.content);
    scroll.addEventListener("scroll", this.onScroll, { passive: true });
  }

  private onScroll = (): void => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.layout();
    });
  };

  /** Dispose: drop listeners and live nodes. */
  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.scroll.removeEventListener("scroll", this.onScroll);
    this.content.remove();
    this.nodes.clear();
  }

  /** Re-measure and re-layout the visible window (e.g. after a resize). */
  refresh(): void {
    this.layout();
  }

  /** Scroll the container to the bottom of the (virtual) conversation. */
  scrollToBottom(): void {
    this.scroll.scrollTop = this.scroll.scrollHeight - this.scroll.clientHeight;
  }

  /** Compute top offsets for every block from measured/estimated heights. */
  private computeOffsets(n: number): number[] {
    const offsets = new Array<number>(n + 1);
    offsets[0] = 0;
    for (let i = 0; i < n; i++) {
      offsets[i + 1] = offsets[i] + (this.heights[i] ?? ESTIMATED);
    }
    return offsets;
  }

  /** Largest block index `i < n` whose span contains `y`. */
  private blockAt(offsets: number[], y: number, n: number): number {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] > y) hi = mid;
      else lo = mid + 1;
    }
    return Math.max(0, lo - 1);
  }

  /** Lay out the visible window; re-runs a few times as heights settle. */
  private layout(depth = 0): void {
    const items = this.getItems();
    const n = items.length;
    if (this.heights.length > n) this.heights.length = n;
    const offsets = this.computeOffsets(n);
    this.content.style.height = `${offsets[n]}px`;
    if (n === 0) {
      for (const node of this.nodes.values()) node.remove();
      this.nodes.clear();
      return;
    }

    const scrollTop = this.scroll.scrollTop;
    const viewport = this.scroll.clientHeight;
    let start = this.blockAt(offsets, scrollTop, n) - BUFFER;
    let end = this.blockAt(offsets, scrollTop + viewport, n) + BUFFER;
    start = Math.max(0, start);
    end = Math.min(n - 1, end);

    for (const [idx, node] of this.nodes) {
      if (idx < start || idx > end) {
        node.remove();
        this.nodes.delete(idx);
      }
    }

    let changed = false;
    for (let i = start; i <= end; i++) {
      let node = this.nodes.get(i);
      if (!node) {
        node = this.renderItem(i, items[i]);
        this.content.append(node);
        this.nodes.set(i, node);
      }
      node.style.top = `${offsets[i]}px`;
      const h = node.offsetHeight + GAP;
      if (this.heights[i] !== h) {
        this.heights[i] = h;
        changed = true;
      }
    }
    if (changed && depth < MAX_PASSES) this.layout(depth + 1);
  }
}

/**
 * A virtualized conversation view. Feed it the active conversation's messages
 * (or append single blocks while a turn streams) and it renders only what's
 * on screen. A transient notice (hint/error) can be shown at the end.
 */
export class MessageView {
  private list: VirtualList;
  private items: VisualItem[] = [];
  private notice: HTMLElement | null = null;
  private scroll: HTMLElement;

  constructor(scroll: HTMLElement) {
    this.scroll = scroll;
    // Take over the notice slot: drop any hint the static markup seeded.
    scroll
      .querySelectorAll(".llm-hint, .llm-loading, .llm-error")
      .forEach((el) => {
        el.remove();
      });
    this.list = new VirtualList(
      scroll,
      (_i, item) => renderItemDom(item),
      () => this.items
    );
  }

  /** Dispose the view and its nodes. */
  destroy(): void {
    this.list.destroy();
    this.clearNotice();
  }

  /**
   * Replace the visible list with `messages`, re-rendering the window. Used on
   * conversation switch, and after a failed turn to roll the DOM back into
   * sync with the store (which already dropped the appended messages).
   */
  setMessages(messages: ChatMessage[]): void {
    this.items = expandMessages(messages);
    this.list.refresh();
    this.list.scrollToBottom();
  }

  /** Append the blocks for one message and follow the new content. */
  appendMessage(msg: ChatMessage): void {
    this.items.push(...expandMessage(msg));
    this.list.refresh();
    this.list.scrollToBottom();
  }

  /** Append a single tool-call label block and follow it. */
  appendToolCall(label: string): void {
    this.items.push({ kind: "tool-call", label });
    this.list.refresh();
    this.list.scrollToBottom();
  }

  /** Append a single tool-result block and follow it. */
  appendToolResult(text: string): void {
    this.items.push({ kind: "tool-result", text });
    this.list.refresh();
    this.list.scrollToBottom();
  }

  /** Append a compaction note and follow it. */
  appendCompaction(): void {
    this.items.push({ kind: "compaction" });
    this.list.refresh();
    this.list.scrollToBottom();
  }

  /**
   * Append a completed subagent run as a collapsed nested block (task, its own
   * tool trace, and final result) and follow it. The trace is not part of the
   * persisted conversation — only the parent tool call and its plain-text
   * result are — so it renders only for the session that ran it.
   */
  appendSubagentResult(
    task: string,
    steps: SubagentStep[],
    result: string
  ): void {
    this.items.push({ kind: "subagent", task, steps, result });
    this.list.refresh();
    this.list.scrollToBottom();
  }

  /**
   * Show a transient notice (a "Thinking…" hint, a loading hint, or an error)
   * at the end of the conversation, replacing any previous one.
   */
  setNotice(kind: "hint" | "loading" | "error", text: string): void {
    this.clearNotice();
    const span = document.createElement("span");
    span.className =
      kind === "error"
        ? "llm-error"
        : kind === "loading"
          ? "llm-loading"
          : "llm-hint";
    span.textContent = text;
    this.scroll.append(span);
    this.notice = span;
  }

  /** Remove the transient notice, if any. */
  clearNotice(): void {
    if (this.notice) {
      this.notice.remove();
      this.notice = null;
    }
  }

  /** Re-layout (e.g. on window resize). */
  refresh(): void {
    this.list.refresh();
  }
}
