/**
 * Markdown-aware line rendering for streaming terminal output.
 *
 * `renderLine` is a pure per-line function: it takes a single completed
 * line plus the current fence state and returns the styled line plus the
 * new fence state. The driver (`index.ts`) owns the line buffer and calls
 * this for each completed line as tokens arrive.
 *
 * Inline formatting is applied via regex replacements:
 *   - backtick spans → cyan
 *   - **bold** spans → bold
 *   - [text](url) links → cyan text with dim url
 *
 * Line-level formatting:
 *   - ``` or ~~~ lines toggle fence state; fence markers are stripped
 *   - lines inside a fence → dim
 *   - # headings → bold
 *   - > blockquotes → dim
 *   - - list items → indented
 *
 * This module imports only from `color.ts` (edge styling helpers). It has
 * no `node:`, `console`, or `process` dependencies beyond what `color.ts`
 * itself needs for TTY detection.
 */
import { bold, cyan, dim } from "./color.ts";

/**
 * Render a single markdown line for terminal display.
 *
 * @param line - The completed line of text (without trailing newline).
 * @param inFence - Whether the previous line opened a code fence.
 * @returns `[styled, newInFence]` — the styled line (without trailing
 *   newline) and whether the fence state changed.
 */
export function renderLine(line: string, inFence: boolean): [string, boolean] {
  const out = line;

  if (inFence) {
    // Closing fence: ``` or ~~~ alone (no language tag, only optional
    // trailing whitespace).
    if (/^\s*(```|~~~)\s*$/.test(out)) {
      return [dim(line), false];
    }
    // Content inside a fence: dim it.
    return [dim(line), true];
  }

  // Opening fence: ``` or ~~~ with optional language tag.
  if (/^\s*(```|~~~)/.test(out)) {
    return [dim(line), true];
  }

  // Headings: # → bold.
  const headingMatch = out.match(/^#{1,6}\s+(.*)$/);
  if (headingMatch) {
    const content = headingMatch[1] ?? "";
    return [bold(applyInline(content)), false];
  }

  // Blockquotes: > → dim.
  const quoteMatch = out.match(/^\s*>+\s*(.*)$/);
  if (quoteMatch) {
    return [dim(applyInline(quoteMatch[1] ?? "")), false];
  }

  // List items: - or * or 1. → indent.
  const listItemMatch = out.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (listItemMatch) {
    const indent = (listItemMatch[1] ?? "") + "  ";
    return [indent + applyInline(listItemMatch[3] ?? ""), false];
  }

  // Regular line: apply inline formatting.
  return [applyInline(out), false];
}

/**
 * Apply inline markdown formatting to a line of text.
 */
function applyInline(text: string): string {
  // Backtick code spans: `code` → cyan.
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => cyan(code));
  // Bold spans: **bold** → bold.
  text = text.replace(/\*\*([^*]+)\*\*/g, (_m, content: string) =>
    bold(content),
  );
  // Links: [text](url) → cyan text + dim url.
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, url: string) => {
      return cyan(label) + dim("(" + url + ")");
    },
  );
  return text;
}
