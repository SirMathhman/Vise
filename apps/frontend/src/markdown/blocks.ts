import { parseInline } from "./inline.js";
import type { Block, Inline } from "./types.js";

/**
 * Block Markdown: paragraphs, headings, fenced code, quotes, lists and rules.
 *
 * Quotes and lists nest recursively, so nesting is capped: past
 * MAX_BLOCK_DEPTH the remaining lines are kept as one literal paragraph
 * (`- - - - ...` would otherwise nest a list per dash and overflow the
 * stack). `parseList` is handed the recursive function instead of calling
 * `parseBlocks` itself, so the two are not mutually recursive.
 */

/** How deeply quotes and lists may nest before the text is left literal. */
export const MAX_BLOCK_DEPTH = 16;

type ParseSub = (lines: string[]) => Block[];

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

/** Whether `line` begins a block that ends a paragraph. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST.test(line)
  );
}

/** Parse a list starting at `lines[i]`; returns the block and the next index. */
function parseList(
  lines: string[],
  i: number,
  parse: ParseSub
): [Block, number] {
  const first = LIST.exec(lines[i]) as RegExpExecArray;
  const ind = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: Block[][] = [];
  let k = i;
  while (k < lines.length) {
    const m = LIST.exec(lines[k]);
    if (!m || m[1].length !== ind || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = lines[k].length - m[3].length;
    const body = [m[3]];
    k++;
    while (k < lines.length) {
      const line = lines[k];
      if (!line.trim()) {
        // A blank line stays in the item only if indented content follows.
        const next = lines.slice(k).find((l) => l.trim());
        if (next !== undefined && indentOf(next) > ind) {
          body.push("");
          k++;
          continue;
        }
        break;
      }
      if (indentOf(line) > ind) {
        body.push(line.slice(Math.min(indentOf(line), contentIndent)));
      } else if (!startsBlock(line) && body[body.length - 1] !== "") {
        body.push(line); // lazy continuation of the item's paragraph
      } else {
        break;
      }
      k++;
    }
    items.push(parse(body));
  }
  return [{ t: "list", ordered, start, items }, k];
}

/** The lines as one literal paragraph, for input nested past the cap. */
function literalParagraph(lines: string[]): Block[] {
  const c: Inline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) c.push({ t: "br" });
    c.push({ t: "text", v: line });
  });
  return c.length > 0 ? [{ t: "p", c }] : [];
}

export function parseBlocks(lines: string[], depth = 0): Block[] {
  if (depth >= MAX_BLOCK_DEPTH) return literalParagraph(lines);
  const sub: ParseSub = (ls) => parseBlocks(ls, depth + 1);
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const closer = new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !closer.test(lines[i]); i++) {
        body.push(lines[i]);
      }
      i++; // the closing fence (or past the end, for an unclosed one)
      out.push({ t: "code", lang: fence[2], v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({
        t: "h",
        level: heading[1].length,
        c: parseInline(heading[2]),
      });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
      }
      out.push({ t: "quote", c: sub(inner) });
      continue;
    }
    if (LIST.test(line)) {
      const [list, next] = parseList(lines, i, sub);
      out.push(list);
      i = next;
      continue;
    }
    const para = [line.trim()];
    for (
      i++;
      i < lines.length && lines[i].trim() && !startsBlock(lines[i]);
      i++
    ) {
      para.push(lines[i].trim());
    }
    out.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return out;
}
