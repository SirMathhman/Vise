/**
 * Custom drop-downs (the ARIA "combobox" pattern: a control, a popup
 * `role=listbox` of `role=option`s) as page scripts. The pattern is a standard,
 * so nothing here is aimed at one site or widget library: it finds the popup by
 * the relationships ARIA defines (`aria-controls`, `aria-owns`,
 * `aria-activedescendant`), falling back to the nearest visible options, and
 * reads what the control shows from the text its own field wrapper displays.
 *
 * Opening the list, filtering and clicking an option are done by the tool layer
 * with the ordinary click/type primitives (trusted input where the engine has
 * it); these scripts only look.
 */

/** In-page helpers shared by the outline and the combobox scripts; defines `viseCombo`. */
export const COMBO_HELPERS = `const viseCombo = (() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const shown = (e) => {
    if (!e || !e.isConnected) return false;
    const r = e.getBoundingClientRect(), st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const POPUP = '[role=combobox],[aria-haspopup=listbox],[aria-haspopup=true][aria-expanded]';
  // The control behind an element: itself, one inside it, one around it, or the only one in its small wrapper (a toggle button next to it).
  const control = (el) => {
    if (el.matches(POPUP)) return el;
    const inner = el.querySelector(POPUP) || el.closest(POPUP);
    if (inner) return inner;
    let p = el.parentElement;
    for (let d = 0; p && d < 3; p = p.parentElement, d++) {
      const all = p.querySelectorAll(POPUP);
      if (all.length === 1) return all[0];
      if (all.length > 1) break;
    }
    return null;
  };
  const optionsOf = (c) => {
    let box = null;
    for (const id of ((c.getAttribute('aria-controls') || '') + ' ' + (c.getAttribute('aria-owns') || '')).split(/\\s+/)) {
      const e = id && document.getElementById(id);
      if (e && (e.matches('[role=listbox]') || e.querySelector('[role=option]'))) { box = e; break; }
    }
    if (!box) {
      const active = c.getAttribute('aria-activedescendant');
      const a = active && document.getElementById(active);
      box = a ? a.closest('[role=listbox]') : null;
    }
    let found = [...(box || document).querySelectorAll('[role=option]')].filter(shown);
    if (!box && found.length > 0) {
      // No declared relationship: the options nearest the control are its popup.
      const cr = c.getBoundingClientRect();
      const dist = (e) => { const r = e.getBoundingClientRect(); return Math.abs(r.top - cr.bottom) + Math.abs(r.left - cr.left); };
      const nearest = found.reduce((m, e) => Math.min(m, dist(e)), Infinity);
      const list = found.find((e) => dist(e) === nearest).closest('[role=listbox]');
      found = list ? found.filter((e) => list.contains(e)) : found.filter((e) => dist(e) < nearest + 600);
    }
    return found;
  };
  // The field wrapper: the largest ancestor that holds no other field, so it is this control's label, value and buttons.
  const wrapper = (c) => {
    let w = c;
    for (let p = c.parentElement, d = 0; p && d < 5; p = p.parentElement, d++) {
      const others = [...p.querySelectorAll('input:not([type=hidden]),select,textarea,[role=combobox]')]
        .filter((e) => e !== c && !c.contains(e) && !e.contains(c));
      if (others.length) break;
      w = p;
    }
    return w;
  };
  // What the control displays: the wrapper's own text, without its label, buttons, popup and live regions.
  const shows = (c) => {
    const w = wrapper(c);
    const skip = new Set();
    for (const id of (c.getAttribute('aria-labelledby') || '').split(/\\s+/)) { const e = id && document.getElementById(id); if (e) skip.add(e); }
    if (c.labels) for (const l of c.labels) skip.add(l);
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) { parts.push(n.nodeValue); return; }
      if (n.nodeType !== 1 || skip.has(n) || n === c || c.contains(n) && n !== w) return;
      if (n.matches('label,button,[role=button],[role=listbox],[aria-live],[aria-hidden=true],script,style') || !shown(n) && n !== w) return;
      for (const k of n.childNodes) walk(k);
    };
    walk(w);
    const text = norm(parts.join(' '));
    return text || ((c.tagName === 'INPUT' || c.tagName === 'TEXTAREA') ? norm(c.value) : '');
  };
  const tag = (e) => {
    let ref = e.getAttribute('data-vise-ref');
    if (!ref) { window.__viseNext = window.__viseNext || 1; ref = 'e' + window.__viseNext++; e.setAttribute('data-vise-ref', ref); }
    return ref;
  };
  return { norm, control, optionsOf, shows, tag };
})();`;

/**
 * Describes the combobox behind `ref`: its control (tagged with a ref, which may
 * be a different element than `ref`), the options of its popup (tagged with
 * refs, in order), whether the popup is open, and what the control shows.
 * Answers `{ error: 'missing' | 'notcombo' }` when there is no such control.
 */
export function comboboxScript(ref: string): string {
  return `((ref) => {
    ${COMBO_HELPERS}
    const el = document.querySelector('[data-vise-ref="' + ref + '"]');
    if (!el) return { error: 'missing' };
    const c = viseCombo.control(el);
    if (!c) return { error: 'notcombo' };
    const options = viseCombo.optionsOf(c).map((o) => ({
      ref: viseCombo.tag(o),
      text: viseCombo.norm(o.innerText || o.textContent),
      selected: o.getAttribute('aria-selected') === 'true',
    }));
    return {
      control: viseCombo.tag(c),
      editable: c.tagName === 'INPUT' || c.tagName === 'TEXTAREA' || c.isContentEditable,
      open: c.getAttribute('aria-expanded') === 'true' || options.length > 0,
      shows: viseCombo.shows(c),
      options,
    };
  })(${JSON.stringify(ref)})`;
}

/** What `comboboxScript` answered. */
export type ComboboxState = {
  error?: "missing" | "notcombo";
  control?: string;
  editable?: boolean;
  open?: boolean;
  shows?: string;
  options?: { ref: string; text: string; selected: boolean }[];
};
