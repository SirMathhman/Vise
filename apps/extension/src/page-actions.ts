/**
 * Scripts the extension runs inside a page (via `tabs.executeScript`). An
 * extension cannot produce trusted input events, so every action here is
 * synthetic: it dispatches the DOM events a user's mouse and keyboard would
 * cause and then triggers the default action itself. Sites that insist on
 * trusted input (file pickers, fullscreen, some captchas and drag-and-drop
 * libraries) will not respond. Each script returns `{ ok: true }` or
 * `{ ok: false, error }`.
 *
 * Element lookup uses the same `data-vise-ref` tags as the snapshot script
 * (`src/browser/page-scripts.ts`, shared with the other backends).
 */

/** The result every action script returns. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Finds a ref'd element, or returns a ready-made failure. */
const FIND = `const find = (ref) => document.querySelector('[data-vise-ref="' + ref + '"]');
  const missing = (ref) => ({ ok: false, error: 'unknown element ' + ref + ': call browser_read for fresh refs' });
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const fire = (el, type, at, extra) => {
    const init = Object.assign({ bubbles: true, cancelable: true, composed: true, view: window, clientX: at.x, clientY: at.y, button: 0 }, extra || {});
    const pointer = type.indexOf('pointer') === 0;
    el.dispatchEvent(pointer ? new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init)) : new MouseEvent(type, init));
  };`;

/** A script about one element: `ref` is in scope, with the helpers above. */
const withRef = (ref: string, body: string): string =>
  `((ref) => {
  ${FIND}
  ${body}
})(${JSON.stringify(ref)})`;

/** One file to put into a file input: its bytes travel base64-encoded. */
export interface UploadFile {
  name: string;
  type: string;
  data: string;
}

/** Fills the input tagged by `fileInputScript` with the files and fires the events a user's choice would. */
export function uploadScript(files: UploadFile[]): string {
  return `((files) => {
  const input = document.querySelector('[data-vise-file]');
  if (!input) return { ok: false, error: 'the file input disappeared' };
  const transfer = new DataTransfer();
  for (const f of files) {
    const text = atob(f.data);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    transfer.items.add(new File([bytes], f.name, { type: f.type }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})(${JSON.stringify(files)})`;
}

/** Scroll the element into view, press and release the mouse on it, then click it. */
export function clickScript(ref: string): string {
  return withRef(
    ref,
    `const el = find(ref);
  if (!el) return missing(ref);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const at = centre(el);
  for (const t of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown']) fire(el, t, at);
  if (typeof el.focus === 'function') el.focus();
  for (const t of ['pointerup', 'mouseup']) fire(el, t, at);
  el.click();
  return { ok: true };`,
  );
}

/** Move the pointer over the element (menus, tooltips). */
export function hoverScript(ref: string): string {
  return withRef(
    ref,
    `const el = find(ref);
  if (!el) return missing(ref);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const at = centre(el);
  for (const t of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove']) fire(el, t, at);
  return { ok: true };`,
  );
}

/** Drag one element onto another with both the mouse and the HTML drag-and-drop events. */
export function dragScript(from: string, to: string): string {
  return `((from, to) => {
  ${FIND}
  const a = find(from);
  if (!a) return missing(from);
  const b = find(to);
  if (!b) return missing(to);
  a.scrollIntoView({ block: 'center', inline: 'center' });
  const p = centre(a);
  const q = centre(b);
  const data = new DataTransfer();
  const drag = (el, type, at) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: at.x, clientY: at.y, dataTransfer: data }));
  fire(a, 'mousedown', p);
  drag(a, 'dragstart', p);
  for (let i = 1; i <= 4; i++) {
    const at = { x: p.x + ((q.x - p.x) * i) / 4, y: p.y + ((q.y - p.y) * i) / 4 };
    fire(b, 'mousemove', at);
    drag(b, i === 1 ? 'dragenter' : 'dragover', at);
  }
  drag(b, 'drop', q);
  drag(a, 'dragend', q);
  fire(b, 'mouseup', q);
  return { ok: true };
})(${JSON.stringify(from)}, ${JSON.stringify(to)})`;
}

/** Insert text at the caret of the focused element, the way typing would. */
export function insertTextScript(text: string): string {
  return `((text) => {
  const el = document.activeElement;
  if (!el) return { ok: false, error: 'nothing is focused: pass a ref' };
  if (document.execCommand('insertText', false, text)) return { ok: true };
  if ('value' in el) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    const start = el.selectionStart == null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    if (setter && setter.set) setter.set.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  return { ok: false, error: 'the focused element does not accept text' };
})(${JSON.stringify(text)})`;
}

/** The keys the agent may press (same set as the other backends), with their DOM names. */
const KEYS: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
};

export const PRESSABLE_KEYS = Object.keys(KEYS);

/**
 * Press a key on the focused element: key events first, then the default
 * action a real key press would have (submit a form on Enter, move focus on
 * Tab, delete on Backspace) unless the page cancelled the event.
 */
export function keyScript(name: string): string | null {
  const key = KEYS[name];
  if (!key) return null;
  return `((name, code, keyCode) => {
  const el = document.activeElement || document.body;
  const init = { key: name, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
  const down = new KeyboardEvent('keydown', init);
  const proceed = el.dispatchEvent(down);
  if (name === 'Enter') el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (!proceed) return { ok: true };
  if (name === 'Enter') {
    if (el.form && el.tagName === 'INPUT') el.form.requestSubmit();
    else if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SUMMARY') el.click();
    else if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertText', false, String.fromCharCode(10));
  } else if (name === 'Backspace') {
    document.execCommand('delete');
  } else if (name === 'Tab') {
    const order = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((e) => !e.disabled && e.offsetParent !== null);
    const next = order[(order.indexOf(el) + 1) % order.length];
    if (next) next.focus();
  }
  return { ok: true };
})(${JSON.stringify(name)}, ${JSON.stringify(key.code)}, ${key.keyCode})`;
}
