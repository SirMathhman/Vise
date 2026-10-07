/**
 * Scripts evaluated inside a page. They tag interactive elements with a
 * `data-vise-ref` attribute (e1, e2, ...) so the model can name an element
 * across tool calls without CSS selectors; the tag survives until the page
 * navigates.
 */

/** Matches `e` followed by digits; the only ref shape the tools accept. */
export const REF_PATTERN = /^e\d+$/;

const MAX_ELEMENTS = 200;

/** Returns one line per visible interactive element: `<ref> <role> "<name>" ...`. */
export const SNAPSHOT_SCRIPT = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[onclick],[onmouseover],[onmouseenter],[ondrop],[ondragover],[draggable=true],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  window.__viseNext = window.__viseNext || 1;
  const lines = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (!r.width || !r.height || st.visibility === 'hidden' || st.display === 'none') continue;
    let ref = el.getAttribute('data-vise-ref');
    if (!ref) { ref = 'e' + window.__viseNext++; el.setAttribute('data-vise-ref', ref); }
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') + ' input' : tag);
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    let extra = '';
    if (tag === 'a' && el.href) extra += ' -> ' + el.href.slice(0, 100);
    if ((tag === 'input' || tag === 'textarea') && el.value && el.type !== 'password') extra += ' value="' + el.value.slice(0, 40) + '"';
    if (el.disabled) extra += ' (disabled)';
    if (el.checked) extra += ' (checked)';
    lines.push(ref + ' ' + role + (name ? ' "' + name + '"' : '') + extra);
    if (lines.length >= ${MAX_ELEMENTS}) break;
  }
  return lines.join('\\n');
})()`;

/** Scrolls the element into view and returns the centre of its box, or null when the ref is gone. */
export function centerScript(ref: string): string {
  return `((ref) => {
    const el = document.querySelector('[data-vise-ref="' + ref + '"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })(${JSON.stringify(ref)})`;
}

/** Focuses the element (optionally selecting its contents); false when the ref is gone. */
export function focusScript(ref: string, selectAll: boolean): string {
  return `((ref, selectAll) => {
    const el = document.querySelector('[data-vise-ref="' + ref + '"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    if (selectAll) {
      if (typeof el.select === 'function') el.select();
      else document.execCommand('selectAll');
    }
    return true;
  })(${JSON.stringify(ref)}, ${selectAll})`;
}

/**
 * A cheap look at the page for the wait tools (see `src/browser/probe.ts`):
 * whether `needle` is on it (case- and whitespace-insensitive), and a
 * fingerprint of its text and element count that changes when the page does.
 * Computed in the page so a poll sends a few bytes, not the whole text.
 */
export function probeScript(needle?: string): string {
  return `((needle) => {
    const norm = (s) => s.replace(/\\s+/g, ' ').toLowerCase();
    const page = norm(document.body ? document.body.innerText : '');
    let h = 5381;
    for (let i = 0; i < page.length; i++) h = ((h << 5) + h + page.charCodeAt(i)) | 0;
    return {
      contains: needle !== null && page.includes(norm(needle)),
      fingerprint: page.length + ':' + h + ':' + document.getElementsByTagName('*').length,
    };
  })(${JSON.stringify(needle ?? null)})`;
}
