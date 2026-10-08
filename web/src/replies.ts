import type { LineModel } from "./chat-lines.ts";
import { nextFrame } from "./follow.ts";
import { createStreamRenderer, showMarkdown } from "./stream-render.ts";

/** A reply still being written: its element and the text so far. */
interface Block {
  element: HTMLElement | null;
  raw: string;
}

/** Add `text` to a block, starting its element at the end of `container` when it has none. */
function extend(
  container: HTMLElement,
  model: LineModel,
  block: Block,
  className: string,
  text: string,
): void {
  if (!block.element) {
    block.element = document.createElement("div");
    block.element.className = `line ${className}`;
    container.appendChild(block.element);
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

/**
 * The replies being streamed: the assistant's own and a subagent's. Each is
 * rendered at most once a frame while it grows (token rates are far above frame
 * rates), and rendered whole when it ends. New text goes where `container()`
 * says (the log, or the open subagent box).
 */
export function createReplies(deps: {
  container: () => HTMLElement;
  model: LineModel;
  renderHtml?: (markdown: string) => string;
  follow: () => void;
  /** A reply starting ends any thinking line before it. */
  endThinking: () => void;
}): {
  appendAssistant(text: string): void;
  appendSubagent(text: string): void;
  /** End the assistant's reply (and the subagent's, unless `keepSubagent`). */
  flush(keepSubagent?: boolean): void;
  reset(): void;
} {
  const { container, model, renderHtml, follow, endThinking } = deps;
  const assistant: Block = { element: null, raw: "" };
  const subagent: Block = { element: null, raw: "" };
  const stream = createStreamRenderer(renderHtml);
  let queued = false;

  function renderOpen(): void {
    queued = false;
    if (subagent.element)
      showMarkdown(subagent.element, subagent.raw, renderHtml);
    if (assistant.element) stream.render(assistant.element, assistant.raw);
    follow();
  }

  function queueRender(): void {
    if (queued) return;
    queued = true;
    nextFrame(renderOpen);
  }

  function flush(keepSubagent = false): void {
    if (!keepSubagent) finishBlock(model, subagent, renderHtml);
    if (!assistant.element) return;
    // The whole reply is rendered once more, so the parts rendered separately while it streamed join up.
    finishBlock(model, assistant, renderHtml);
    stream.reset();
    follow();
  }

  return {
    appendAssistant(text) {
      endThinking();
      extend(container(), model, assistant, "assistant", text);
      queueRender();
    },
    appendSubagent(text) {
      flush(true);
      endThinking();
      extend(container(), model, subagent, "assistant subagent", text);
      queueRender();
    },
    flush,
    reset() {
      assistant.element = null;
      subagent.element = null;
      stream.reset();
    },
  };
}
