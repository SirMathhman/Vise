// Markdown for the model's replies: a common subset, read as plain data and built into DOM nodes with
// createElement and textContent only, so model output never becomes markup.

export interface HeadingBlock {
  kind: "heading";
  level: number;
  text: string;
}

export interface ParagraphBlock {
  kind: "paragraph";
  text: string;
}

export interface CodeBlock {
  kind: "code";
  text: string;
}

export interface ListBlock {
  kind: "list";
  ordered: boolean;
  items: string[];
}

export interface ListItem {
  ordered: boolean;
  text: string;
}

export type MarkdownBlock = HeadingBlock | ParagraphBlock | CodeBlock | ListBlock;

export interface InlinePart {
  kind: "text" | "code" | "strong" | "em";
  text: string;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

// Splits Markdown text into blocks. A line that starts a fence, heading, or list ends a paragraph.
export function markdownBlocks(source: string): MarkdownBlock[] {
  // Windows line endings (CRLF) are read as line ends too, so a file's heading is not left with a stray \r.
  const lines = source.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
    } else if (FENCE.test(line)) {
      index = readFence(lines, index, blocks);
    } else if (HEADING.test(line)) {
      const match = HEADING.exec(line);
      blocks.push({ kind: "heading", level: match?.[1]?.length ?? 1, text: match?.[2] ?? "" });
      index += 1;
    } else if (listItem(line) !== undefined) {
      index = readList(lines, index, blocks);
    } else {
      index = readParagraph(lines, index, blocks);
    }
  }
  return blocks;
}

// The text of a list item and whether it is numbered, or undefined when the line is not an item.
function listItem(line: string): ListItem | undefined {
  const bullet = BULLET.exec(line);
  if (bullet !== null) return { ordered: false, text: bullet[1] ?? "" };
  const numbered = NUMBERED.exec(line);
  if (numbered !== null) return { ordered: true, text: numbered[1] ?? "" };
  return undefined;
}

// Reads a fenced block up to its closing fence, or to the end when it is not closed.
function readFence(lines: string[], start: number, blocks: MarkdownBlock[]): number {
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
    body.push(lines[index] ?? "");
    index += 1;
  }
  blocks.push({ kind: "code", text: body.join("\n") });
  return index + 1;
}

// Reads consecutive items of one kind (bulleted or numbered) into a single list.
function readList(lines: string[], start: number, blocks: MarkdownBlock[]): number {
  const first = listItem(lines[start] ?? "");
  const items: string[] = [];
  let index = start;
  while (index < lines.length) {
    const item = listItem(lines[index] ?? "");
    if (item === undefined || item.ordered !== first?.ordered) break;
    items.push(item.text);
    index += 1;
  }
  blocks.push({ kind: "list", ordered: first?.ordered ?? false, items });
  return index;
}

// Reads lines up to a blank line or the start of another block, joined with spaces.
function readParagraph(lines: string[], start: number, blocks: MarkdownBlock[]): number {
  const words: string[] = [];
  let index = start;
  while (index < lines.length && (lines[index] ?? "").trim() !== "" && !startsBlock(lines[index] ?? "")) {
    words.push((lines[index] ?? "").trim());
    index += 1;
  }
  blocks.push({ kind: "paragraph", text: words.join(" ") });
  return index;
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || listItem(line) !== undefined;
}

// Splits one line of text into plain, code, strong, and emphasis parts. A link keeps its text and drops
// its address, so the page never shows a link it did not check.
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
    parts.push(inlinePart(match));
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

function inlinePart(match: RegExpMatchArray): InlinePart {
  if (match[1] !== undefined) return { kind: "code", text: match[1] };
  if (match[2] !== undefined) return { kind: "strong", text: match[2] };
  if (match[3] !== undefined) return { kind: "em", text: match[3] };
  return { kind: "text", text: match[4] ?? "" };
}

// Builds the DOM for a reply. Every string is set with textContent.
export function renderMarkdown(doc: Document, source: string): HTMLElement[] {
  return markdownBlocks(source).map((block) => blockNode(doc, block));
}

function blockNode(doc: Document, block: MarkdownBlock): HTMLElement {
  switch (block.kind) {
    case "heading": {
      const node = doc.createElement(`h${block.level + 2}`);
      node.append(...inlineNodes(doc, block.text));
      return node;
    }
    case "paragraph": {
      const node = doc.createElement("p");
      node.append(...inlineNodes(doc, block.text));
      return node;
    }
    case "code": {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      return pre;
    }
    case "list": {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const node = doc.createElement("li");
        node.append(...inlineNodes(doc, item));
        list.append(node);
      }
      return list;
    }
  }
}

function inlineNodes(doc: Document, text: string): Node[] {
  return inlineParts(text).map((part) => {
    if (part.kind === "text") return doc.createTextNode(part.text);
    const node = doc.createElement(part.kind === "code" ? "code" : part.kind === "strong" ? "strong" : "em");
    node.textContent = part.text;
    return node;
  });
}
