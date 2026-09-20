import type { Inline } from "./types.js";

/**
 * Inline Markdown: code spans, links, emphasis, escapes and line breaks.
 *
 * Nesting (emphasis inside a link inside emphasis, ...) is recursive, so it is
 * capped: past MAX_INLINE_DEPTH the remaining text is kept literally. Model
 * output can be degenerate (thousands of unmatched `[` or `*`), and an
 * unbounded recursion would overflow the stack. The helpers that need to parse
 * a sub-range (`tryLink`, `tryEmphasis`) are handed the recursive function
 * rather than calling `parseInline` themselves, so there is no mutual
 * recursion between functions.
 */

/** How deeply inline constructs may nest before the text is left literal. */
export const MAX_INLINE_DEPTH = 24;

type ParseSub = (s: string) => Inline[];
type Found = { node: Inline; end: number };

const PUNCT = /[\\`*_{}[\]()#+\-.!~>|]/;

/** Index of a run of exactly `n` `ch`s at or after `from`, or -1. */
function findRun(s: string, ch: string, n: number, from: number): number {
  const run = ch.repeat(n);
  for (let k = s.indexOf(run, from); k >= 0; k = s.indexOf(run, k + 1)) {
    if (s[k - 1] !== ch && s[k + n] !== ch) return k;
  }
  return -1;
}

/** `[text](url)` starting at `i`: the link node and the index after it. */
function tryLink(s: string, i: number, parse: ParseSub): Found | null {
  let depth = 0;
  let close = -1;
  for (let k = i; k < s.length; k++) {
    if (s[k] === "\\") k++;
    else if (s[k] === "[") depth++;
    else if (s[k] === "]" && --depth === 0) {
      close = k;
      break;
    }
  }
  if (close < 0 || s[close + 1] !== "(") return null;
  let parens = 0;
  let end = -1;
  for (let k = close + 1; k < s.length; k++) {
    if (s[k] === "(") parens++;
    else if (s[k] === ")" && --parens === 0) {
      end = k;
      break;
    }
  }
  if (end < 0) return null;
  const href =
    s
      .slice(close + 2, end)
      .trim()
      .split(/\s+/)[0] ?? "";
  const label = s.slice(i + 1, close);
  if (!href || !label.trim()) return null;
  return { node: { t: "link", href, c: parse(label) }, end: end + 1 };
}

const isSpace = (c: string | undefined): boolean =>
  c === undefined || /\s/.test(c);
const isWord = (c: string | undefined): boolean =>
  c !== undefined && /\w/.test(c);

/** `*`/`_` emphasis starting at `i`: the node and the index after it. */
function tryEmphasis(s: string, i: number, parse: ParseSub): Found | null {
  const ch = s[i];
  let n = 1;
  while (s[i + n] === ch && n < 3) n++;
  if (isSpace(s[i + n])) return null;
  // Intraword underscores (snake_case) are not emphasis.
  if (ch === "_" && isWord(s[i - 1])) return null;
  for (let k = s.indexOf(ch, i + n); k >= 0; k = s.indexOf(ch, k + 1)) {
    if (s[k - 1] === "\\" || isSpace(s[k - 1])) continue;
    if (s.slice(k, k + n) !== ch.repeat(n) || s[k + n] === ch) continue;
    if (ch === "_" && isWord(s[k + n])) continue;
    const inner = parse(s.slice(i + n, k));
    const node: Inline =
      n === 1
        ? { t: "em", c: inner }
        : n === 2
          ? { t: "strong", c: inner }
          : { t: "strong", c: [{ t: "em", c: inner }] };
    return { node, end: k + n };
  }
  return null;
}

export function parseInline(s: string, depth = 0): Inline[] {
  if (depth >= MAX_INLINE_DEPTH) return s ? [{ t: "text", v: s }] : [];
  const sub: ParseSub = (t) => parseInline(t, depth + 1);
  const out: Inline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
    } else if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
    } else if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const close = findRun(s, "`", n, i + n);
      if (close < 0) {
        buf += "`".repeat(n);
        i += n;
        continue;
      }
      flush();
      let v = s.slice(i + n, close);
      if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ")) {
        v = v.slice(1, -1);
      }
      out.push({ t: "code", v });
      i = close + n;
    } else {
      const found =
        ch === "["
          ? tryLink(s, i, sub)
          : ch === "*" || ch === "_"
            ? tryEmphasis(s, i, sub)
            : null;
      if (found) {
        flush();
        out.push(found.node);
        i = found.end;
      } else {
        buf += ch;
        i++;
      }
    }
  }
  flush();
  return out;
}
