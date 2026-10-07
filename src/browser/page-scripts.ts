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
    const field = tag === 'input' || tag === 'select' || tag === 'textarea';
    const labelled = el.getAttribute('aria-labelledby');
    const label = field ? ((el.labels && el.labels[0] && el.labels[0].innerText) || (labelled && (document.getElementById(labelled.split(' ')[0]) || {}).innerText) || '') : '';
    const own = tag === 'select' ? '' : (el.innerText || el.value || '');
    const name = (el.getAttribute('aria-label') || label || own || el.placeholder || el.title || el.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    let extra = '';
    if (tag === 'select') {
      const opts = [...el.options].map((o) => o.text.replace(/\\s+/g, ' ').trim().slice(0, 40));
      const chosen = el.selectedIndex >= 0 ? opts[el.selectedIndex] : '';
      extra += (chosen ? ' value="' + chosen + '"' : '') + ' options: ' + opts.slice(0, 25).join(' | ') + (opts.length > 25 ? ' | ... ' + (opts.length - 25) + ' more' : '');
    }
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

/** Attribute that marks the file input an upload is aimed at (so each backend can select it). */
export const FILE_INPUT_SELECTOR = "[data-vise-file]";

/**
 * Finds the file input that the element `ref` stands for - the input itself, the
 * one a label points at, or one inside or next to a styled "upload" button - and
 * tags it. Returns 'missing' (no such ref), 'none' (no file input there),
 * 'single' or 'multiple'.
 */
export function fileInputScript(ref: string): string {
  return `((ref) => {
    for (const old of document.querySelectorAll('[data-vise-file]')) old.removeAttribute('data-vise-file');
    const el = document.querySelector('[data-vise-ref="' + ref + '"]');
    if (!el) return 'missing';
    const isFile = (e) => !!e && e.tagName === 'INPUT' && e.type === 'file';
    let input = isFile(el) ? el : el.tagName === 'LABEL' ? el.control : null;
    for (let p = el, depth = 0; !isFile(input) && p && depth < 4; p = p.parentElement, depth++) {
      input = p.querySelector('input[type=file]');
    }
    if (!isFile(input)) return 'none';
    input.setAttribute('data-vise-file', '1');
    return input.multiple ? 'multiple' : 'single';
  })(${JSON.stringify(ref)})`;
}

/** The error to report for a `fileInputScript` result and a number of files, or null when the upload can go ahead. */
export function fileInputProblem(
  status: string,
  ref: string,
  count: number,
): string | null {
  if (status === "missing") {
    return `unknown element ${ref}: call browser_read for fresh refs`;
  }
  if (status === "none") {
    return `${ref} is not a file input and no file input was found with it`;
  }
  if (status === "single" && count > 1) {
    return "that file input accepts only one file";
  }
  return null;
}

/**
 * Chooses options of the `<select>` behind `ref` by value or visible text
 * (exact first, then a case-insensitive part of the text) and fires the
 * `input` and `change` events a user's choice would. A native drop-down list
 * cannot be driven by clicks or typing, so this is how options get chosen.
 * Returns `{ selected: [...] }` or `{ error, options? }`.
 */
export function selectScript(ref: string, wanted: string[]): string {
  return `((ref, wanted) => {
    const el = document.querySelector('[data-vise-ref="' + ref + '"]');
    if (!el) return { error: 'missing' };
    if (el.tagName !== 'SELECT') return { error: 'notselect' };
    const opts = [...el.options];
    const list = opts.map((o) => o.text.replace(/\\s+/g, ' ').trim());
    if (el.disabled) return { error: 'disabled', options: list };
    const norm = (s) => s.replace(/\\s+/g, ' ').trim().toLowerCase();
    const pick = (w) => opts.find((o) => !o.disabled && o.value === w)
      || opts.find((o) => !o.disabled && norm(o.text) === norm(w))
      || opts.find((o) => !o.disabled && norm(o.text).includes(norm(w)));
    const chosen = wanted.map(pick);
    const bad = wanted.filter((_, i) => !chosen[i]);
    if (bad.length > 0) return { error: 'nooption', bad, options: list };
    if (!el.multiple && chosen.length > 1) return { error: 'single', options: list };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (el.multiple) { for (const o of opts) o.selected = chosen.includes(o); }
    else el.selectedIndex = opts.indexOf(chosen[0]);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: chosen.map((o) => o.text.replace(/\\s+/g, ' ').trim()) };
  })(${JSON.stringify(ref)}, ${JSON.stringify(wanted)})`;
}

/** What `selectScript` answered, as the chosen texts; throws an `Error` fit to show the model when it could not choose. */
export function selectedOrThrow(
  ref: string,
  result: {
    selected?: string[];
    error?: string;
    bad?: string[];
    options?: string[];
  },
): string[] {
  if (result.selected) return result.selected;
  const options = (result.options ?? []).slice(0, 60).join(" | ");
  switch (result.error) {
    case "missing":
      throw new Error(
        `unknown element ${ref}: call browser_read for fresh refs`,
      );
    case "notselect":
      throw new Error(
        `${ref} is not a drop-down (<select>); use browser_click or browser_type`,
      );
    case "disabled":
      throw new Error(
        `${ref} is disabled (an earlier choice may enable it). Options: ${options}`,
      );
    case "single":
      throw new Error(`${ref} takes one choice. Options: ${options}`);
    default:
      throw new Error(
        `no option matching ${(result.bad ?? []).map((b) => JSON.stringify(b)).join(", ")} in ${ref}. Options: ${options}`,
      );
  }
}

/**
 * Page actions: an action on one ref'd element, run as a script in the page
 * that answers with JSON. A new widget gets one entry here (and a tool); every
 * backend runs it through `BrowserBackend.runPageAction`, so none needs its own
 * method. The extension builds the script itself from the named action (it
 * never runs script text sent by the server).
 */
export type PageAction = { name: "select"; ref: string; wanted: string[] };

/** The script for an action; throws when its ref is not a valid one or the action is unknown. */
export function pageActionScript(action: PageAction): string {
  if (typeof action !== "object" || action === null) {
    throw new Error("invalid page action");
  }
  if (!REF_PATTERN.test(String(action.ref))) {
    throw new Error(`invalid ref: ${String(action.ref)}`);
  }
  switch (action.name) {
    case "select":
      return selectScript(action.ref, [...action.wanted].map(String));
    default:
      throw new Error(`unknown page action: ${String(action.name)}`);
  }
}
