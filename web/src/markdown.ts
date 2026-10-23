// Markdown rendering for the chat, notes and file viewers. marked and DOMPurify come from the page's script tags.
declare const marked: { parse(text: string): string; use(extension: { renderer: { html(html: string): string } }): void };
declare const DOMPurify: { sanitize(dirty: string): string };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Raw HTML in markdown is shown as text, never inserted as HTML.
if (typeof marked !== "undefined") {
  marked.use({ renderer: { html: escapeHtml } });
}

// Markdown to sanitized HTML. Without the libraries the text is escaped, so it still shows as text.
function renderMarkdown(text: string): string {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escapeHtml(text);
  }
  return DOMPurify.sanitize(marked.parse(text));
}
