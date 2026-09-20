// Dependency-free Markdown for the model's replies: a DOM-free parser that
// produces a small block/inline tree, and a renderer that builds DOM nodes
// from it. Nothing here ever builds HTML from the text (no innerHTML), so
// raw `<script>`/`<img onerror>` in a reply is just displayed as text, and the
// only URLs that become links are absolute http(s) ones — model output can
// carry injected content, so safety is by construction rather than by
// sanitizing. Supported: paragraphs (a single newline is a line break, as in
// chat UIs), headings, bold/italic, inline code, fenced code (highlighted),
// bullet/numbered lists (nested), blockquotes, links, and horizontal rules.
// Anything else (tables, HTML, images) stays plain text. An unclosed fence or
// emphasis renders literally until it closes, so a streaming reply is fine.

import { appendHighlighted } from "./highlight.js";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "em"; c: Inline[] }
  | { t: "strong"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const PUNCT = /[\\`*_{}[\]()#+\-.!~>|]/;

// ── Inline ─────────────────────────────────────────────────────────────

/** Index of a run of exactly `n` `ch`s at or after `from`, or -1. */
function findRun(s: string, ch: string, n: number, from: number): number {
  const run = ch.repeat(n);
  for (let k = s.indexOf(run, from); k >= 0; k = s.indexOf(run, k + 1)) {
    if (s[k - 1] !== ch && s[k + n] !== ch) return k;
  }
  return -1;
}

/** `[text](url)` starting at `i`: the link node and the index after it. */
function tryLink(s: string, i: number): { node: Inline; end: number } | null {
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
  return {
    node: { t: "link", href, c: parseInline(label) },
    end: end + 1,
  };
}

const isSpace = (c: string | undefined): boolean =>
  c === undefined || /\s/.test(c);
const isWord = (c: string | undefined): boolean =>
  c !== undefined && /\w/.test(c);

/** `*`/`_` emphasis starting at `i`: the node and the index after it. */
function tryEmphasis(
  s: string,
  i: number
): { node: Inline; end: number } | null {
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
    const inner = parseInline(s.slice(i + n, k));
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

export function parseInline(s: string): Inline[] {
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
          ? tryLink(s, i)
          : ch === "*" || ch === "_"
            ? tryEmphasis(s, i)
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

// ── Blocks ─────────────────────────────────────────────────────────────

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
function parseList(lines: string[], i: number): [Block, number] {
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
    items.push(parseBlocks(body));
  }
  return [{ t: "list", ordered, start, items }, k];
}

export function parseBlocks(lines: string[]): Block[] {
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
      out.push({ t: "quote", c: parseBlocks(inner) });
      continue;
    }
    if (LIST.test(line)) {
      const [list, next] = parseList(lines, i);
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

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

// ── DOM ────────────────────────────────────────────────────────────────

/** An absolute http(s) URL, normalized; anything else is not linkable. */
function safeHref(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function renderInline(nodes: Inline[], parent: Node): void {
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        parent.appendChild(document.createTextNode(n.v));
        break;
      case "br":
        parent.appendChild(document.createElement("br"));
        break;
      case "code": {
        const el = document.createElement("code");
        el.className = "llm-md-code";
        el.textContent = n.v;
        parent.appendChild(el);
        break;
      }
      case "em":
      case "strong": {
        const el = document.createElement(n.t);
        renderInline(n.c, el);
        parent.appendChild(el);
        break;
      }
      case "link": {
        const href = safeHref(n.href);
        if (!href) {
          // Not a safe link: show the label only.
          renderInline(n.c, parent);
          break;
        }
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        // The real destination, so a label can't disguise where it goes.
        a.title = href;
        renderInline(n.c, a);
        parent.appendChild(a);
        break;
      }
    }
  }
}

function renderBlock(b: Block): Node {
  switch (b.t) {
    case "p": {
      const p = document.createElement("p");
      renderInline(b.c, p);
      return p;
    }
    case "h": {
      const h = document.createElement(`h${b.level}`);
      h.className = "llm-md-h";
      renderInline(b.c, h);
      return h;
    }
    case "hr":
      return document.createElement("hr");
    case "quote": {
      const q = document.createElement("blockquote");
      for (const c of b.c) q.appendChild(renderBlock(c));
      return q;
    }
    case "list": {
      const list = document.createElement(b.ordered ? "ol" : "ul");
      if (b.ordered && b.start !== 1) {
        list.setAttribute("start", String(b.start));
      }
      for (const item of b.items) {
        const li = document.createElement("li");
        for (const c of item) li.appendChild(renderBlock(c));
        list.appendChild(li);
      }
      return list;
    }
    case "code": {
      const pre = document.createElement("pre");
      pre.className = "llm-md-pre";
      const code = document.createElement("code");
      b.v.split("\n").forEach((line, i) => {
        if (i > 0) code.appendChild(document.createTextNode("\n"));
        appendHighlighted(code, line);
      });
      pre.appendChild(code);
      return pre;
    }
  }
}

/** Replace `el`'s content with the rendered Markdown of `text`. */
export function renderMarkdownInto(el: HTMLElement, text: string): void {
  el.replaceChildren(...parseMarkdown(text).map(renderBlock));
}
