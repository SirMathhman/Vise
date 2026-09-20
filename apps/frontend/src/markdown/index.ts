// Dependency-free Markdown for the model's replies. `parseMarkdown` is a
// DOM-free parser producing a small block/inline tree (types.ts, inline.ts,
// blocks.ts); `renderMarkdownInto` builds DOM nodes from it (dom.ts). Nothing
// ever builds HTML from the text (no innerHTML), so raw `<script>`/`<img
// onerror>` in a reply is just displayed as text, and only absolute http(s)
// URLs become links — model output can carry injected content, so safety is
// by construction rather than by sanitizing. Nesting is depth-capped, so
// degenerate input can't overflow the stack.
//
// Supported: paragraphs (a single newline is a line break, as in chat UIs),
// headings, bold/italic, inline code, fenced code (highlighted), bullet/
// numbered lists (nested), blockquotes, links, and horizontal rules. Anything
// else (tables, HTML, images) stays plain text. An unclosed fence or emphasis
// renders literally until it closes, so a streaming reply is fine.

import { parseBlocks } from "./blocks.js";
import { renderBlock } from "./dom.js";
import type { Block } from "./types.js";

export type { Block, Inline } from "./types.js";

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

/** Replace `el`'s content with the rendered Markdown of `text`. */
export function renderMarkdownInto(el: HTMLElement, text: string): void {
  try {
    el.replaceChildren(...parseMarkdown(text).map(renderBlock));
  } catch {
    // A safety net for anything unforeseen: never let a reply break the
    // transcript — fall back to showing it as plain text.
    el.textContent = text;
  }
}
