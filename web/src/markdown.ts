import DOMPurify from "dompurify";
import { marked } from "marked";
import { codeRenderer } from "./highlight.ts";

// Fenced blocks in a language we know are highlighted (see `codeRenderer`); the rest render as marked does.
marked.use({ renderer: { code: codeRenderer } });

// Open links in a new tab without handing the page to the target.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * Render model-written markdown (code, headings, emphasis, links, lists,
 * quotes, tables) to sanitized HTML. The output is safe to assign to
 * `innerHTML`: everything the model writes passes through DOMPurify.
 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}
