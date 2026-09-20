import { appendHighlighted } from "../highlight.js";
import type { Block, Inline } from "./types.js";

/**
 * The renderer: builds DOM nodes from the Markdown tree. The only module in
 * markdown/ that touches `document`. Nothing here builds HTML from text (no
 * innerHTML), and the only attribute an attacker influences, a link's `href`,
 * is set only for absolute http(s) URLs. Recursion depth is bounded by the
 * parser's nesting caps.
 */

/** An absolute http(s) URL, normalized; anything else is not linkable. */
export function safeHref(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** `inLink`: already inside an `<a>`, where a nested link is invalid HTML. */
function renderInline(nodes: Inline[], parent: Node, inLink = false): void {
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
        renderInline(n.c, el, inLink);
        parent.appendChild(el);
        break;
      }
      case "link": {
        const href = safeHref(n.href);
        if (!href || inLink) {
          // Not a safe (or not a nestable) link: show the label only.
          renderInline(n.c, parent, inLink);
          break;
        }
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        // The real destination, so a label can't disguise where it goes.
        a.title = href;
        renderInline(n.c, a, true);
        parent.appendChild(a);
        break;
      }
    }
  }
}

export function renderBlock(b: Block): Node {
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
