// Markdown as DOM: the blocks of markdown.ts built into nodes with createElement and textContent only, so model
// output and file text never become markup.

import { inlineParts, markdownBlocks, type MarkdownBlock } from "../markdown.ts";

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
