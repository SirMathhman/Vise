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
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = { above: 0, below: 0, left: 0, right: 0, covered: 0 };
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (!r.width || !r.height || st.visibility === 'hidden' || st.display === 'none') continue;
    // Only what is clearly in view: at least half of the element (or a large part of a big one) inside the viewport, and not covered by something else.
    const shownW = Math.min(r.right, vw) - Math.max(r.left, 0);
    const shownH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    const shown = shownW > 0 && shownH > 0 ? shownW * shownH : 0;
    if (shown < 0.5 * r.width * r.height && shown < 40000) {
      const cy = r.top + r.height / 2, cx = r.left + r.width / 2;
      if (cy >= vh) out.below++; else if (cy < 0) out.above++; else if (cx >= vw) out.right++; else out.left++;
      continue;
    }
    const px = Math.min(Math.max(Math.max(r.left, 0) + shownW / 2, 0), vw - 1);
    const py = Math.min(Math.max(Math.max(r.top, 0) + shownH / 2, 0), vh - 1);
    const top = document.elementFromPoint(px, py);
    const swatch = (el.type === 'checkbox' || el.type === 'radio') && el.parentElement && el.parentElement.contains(top);
    if (top && !(el.contains(top) || swatch || (el.labels && [...el.labels].some((l) => l.contains(top))))) { out.covered++; continue; }
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
  // What the list leaves out, and how to reach it.
  const notes = [];
  const hidden = [out.below && out.below + ' below', out.above && out.above + ' above', out.right && out.right + ' to the right', out.left && out.left + ' to the left', out.covered && out.covered + ' hidden behind or clipped by another element'].filter(Boolean);
  if (hidden.length) notes.push('not listed (outside the viewport or hidden): ' + hidden.join(', ') + '. Use browser_scroll to bring them into view');
  const root = document.scrollingElement || document.documentElement;
  const span = (pos, size, view, before, after) => 'showing ' + Math.round(pos) + '-' + Math.round(Math.min(pos + view, size)) + ' of ' + size + (pos > 1 ? ' (more ' + before + ')' : '') + (pos + view < size - 1 ? ' (more ' + after + ')' : '');
  if (root.scrollHeight > vh + 1) notes.push('page vertically ' + span(root.scrollTop, root.scrollHeight, vh, 'above', 'below'));
  if (root.scrollWidth > vw + 1) notes.push('page horizontally ' + span(root.scrollLeft, root.scrollWidth, vw, 'to the left', 'to the right'));
  let panels = 0;
  for (const el of document.querySelectorAll('div,ul,ol,section,main,aside,nav,table,form')) {
    if (panels >= 5) break;
    if (el.clientHeight < 120 || el.clientWidth < 150 || el.scrollHeight <= el.clientHeight + 20) continue;
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    let ref = el.getAttribute('data-vise-ref');
    if (!ref) { ref = 'e' + window.__viseNext++; el.setAttribute('data-vise-ref', ref); }
    const title = (el.getAttribute('aria-label') || (el.innerText || '').trim().split('\\n')[0] || '').slice(0, 40);
    notes.push('scrollable area ' + ref + (title ? ' "' + title + '"' : '') + ' ' + span(el.scrollTop, el.scrollHeight, el.clientHeight, 'above', 'below') + '; scroll it with browser_scroll and this ref');
    panels++;
  }
  return lines.concat(notes.map((n) => '[' + n + ']')).join('\\n');
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
export type PageAction =
  | { name: "select"; ref: string; wanted: string[] }
  | {
      name: "scroll";
      /** An element inside the area to scroll; without one, the page (or its largest scrollable area). */
      ref?: string;
      direction: ScrollDirection;
      /** Pixels; a page-sized step (80% of the visible height or width) when absent. */
      amount?: number;
    };

export const SCROLL_DIRECTIONS = [
  "up",
  "down",
  "left",
  "right",
  "top",
  "bottom",
] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

/** The script for an action; throws when its ref is not a valid one or the action is unknown. */
export function pageActionScript(action: PageAction): string {
  if (typeof action !== "object" || action === null) {
    throw new Error("invalid page action");
  }
  if (action.ref !== undefined && !REF_PATTERN.test(String(action.ref))) {
    throw new Error(`invalid ref: ${String(action.ref)}`);
  }
  switch (action.name) {
    case "select":
      if (action.ref === undefined)
        throw new Error("a drop-down ref is required");
      return selectScript(action.ref, [...action.wanted].map(String));
    case "scroll":
      if (!SCROLL_DIRECTIONS.includes(action.direction)) {
        throw new Error(
          `direction must be one of ${SCROLL_DIRECTIONS.join(", ")}`,
        );
      }
      return scrollScript(
        action.ref,
        action.direction,
        Number(action.amount) || 0,
      );
    default:
      throw new Error(
        `unknown page action: ${String((action as { name: unknown }).name)}`,
      );
  }
}

/**
 * Scrolls the page, or the scrollable area around `ref` (or, when the page
 * itself cannot scroll that way, the largest scrollable area in view), by one
 * page-sized step or `amount` pixels, or to the very start or end. Answers with
 * where it ended up, so the model knows what is left to reach.
 */
export function scrollScript(
  ref: string | undefined,
  direction: ScrollDirection,
  amount: number,
): string {
  return `((ref, dir, amount) => {
    const vertical = dir === 'up' || dir === 'down' || dir === 'top' || dir === 'bottom';
    const canScroll = (el) => {
      const st = getComputedStyle(el);
      return vertical
        ? /(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1
        : /(auto|scroll|overlay)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1;
    };
    const root = document.scrollingElement || document.documentElement;
    let target = null;
    if (ref) {
      let el = document.querySelector('[data-vise-ref="' + ref + '"]');
      if (!el) return { error: 'missing' };
      for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        if (canScroll(el)) { target = el; break; }
      }
    }
    if (!target) {
      const rootCan = vertical ? root.scrollHeight > window.innerHeight + 1 : root.scrollWidth > window.innerWidth + 1;
      if (rootCan) target = root;
      else {
        let best = 0;
        for (const el of document.querySelectorAll('div,ul,ol,section,main,aside,nav,table,form')) {
          if (!canScroll(el)) continue;
          const r = el.getBoundingClientRect();
          const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
          const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
          if (w > 0 && h > 0 && w * h > best) { best = w * h; target = el; }
        }
      }
    }
    if (!target) return { error: 'nothing' };
    const isRoot = target === root;
    const view = vertical ? (isRoot ? window.innerHeight : target.clientHeight) : (isRoot ? window.innerWidth : target.clientWidth);
    const total = vertical ? target.scrollHeight : target.scrollWidth;
    const read = () => (vertical ? target.scrollTop : target.scrollLeft);
    const before = read();
    const step = amount > 0 ? amount : Math.round(view * 0.8);
    const delta = dir === 'up' || dir === 'left' ? -step : dir === 'top' ? -total : dir === 'bottom' ? total : step;
    const options = { behavior: 'instant' };
    if (vertical) options.top = delta; else options.left = delta;
    (isRoot ? window : target).scrollBy(options);
    const after = read();
    return { moved: Math.round(after - before), from: Math.round(after), to: Math.round(Math.min(after + view, total)), total, area: isRoot ? '' : (target.getAttribute('data-vise-ref') || 'a scrollable area') };
  })(${JSON.stringify(ref ?? null)}, ${JSON.stringify(direction)}, ${JSON.stringify(amount)})`;
}

/** What `scrollScript` answered, as a sentence for the model; throws when nothing could be scrolled. */
export function scrollSummary(
  direction: ScrollDirection,
  result: {
    error?: string;
    moved?: number;
    from?: number;
    to?: number;
    total?: number;
    area?: string;
  },
  ref?: string,
): string {
  if (result.error === "missing") {
    throw new Error(`unknown element ${ref}: call browser_read for fresh refs`);
  }
  if (result.error || result.moved === undefined) {
    throw new Error(
      "nothing on this page scrolls that way (browser_read lists scrollable areas with their refs)",
    );
  }
  const where = result.area ? `area ${result.area}` : "the page";
  const axis =
    direction === "up" ||
    direction === "down" ||
    direction === "top" ||
    direction === "bottom"
      ? "vertically"
      : "horizontally";
  const edge = (before: string, after: string): string =>
    `${(result.from ?? 0) > 1 ? ` (more ${before})` : ""}${(result.to ?? 0) < (result.total ?? 0) - 1 ? ` (more ${after})` : ""}`;
  const where2 =
    axis === "vertically"
      ? edge("above", "below")
      : edge("to the left", "to the right");
  const moved =
    result.moved === 0
      ? `could not scroll ${direction} any further`
      : `scrolled ${direction} ${Math.abs(result.moved)}px`;
  return `${moved}; ${where} now shows ${axis} ${result.from}-${result.to} of ${result.total}${where2}. Call browser_read to see what is in view now.`;
}
