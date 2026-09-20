// Vise Browser Control — content script.
//
// Runs in every page and implements the model's page tools inside the page
// itself: the same numbered snapshot of interactive elements the Vise
// backend's Chrome tools produce (backend routes/browser/elements.ts — kept
// in step by hand; there is no shared build), and click / type / hover / drag /
// read on an element by its number. Every action re-collects the element list
// immediately before acting, so a number always maps to a live element.
//
// Limits of working from a page script: the events it dispatches are
// synthetic, so a page that requires a *trusted* event ignores them, CSS
// :hover styling can't be triggered by hover (only mouse-event listeners see
// it), and a key press can't perform the browser's default action except the
// few emulated below (typing a character, Backspace, Enter-submit, Tab focus).

(() => {
  if (globalThis.__viseControl) return; // injected twice (declared + on attach)
  globalThis.__viseControl = true;

  const SELECTOR =
    "button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=link], [contenteditable=true], summary, [draggable=true]";
  const MAX_ELEMENTS = 100;
  const MAX_TEXT = 20000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── The numbered snapshot ─────────────────────────────────────────────

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  /** The interactive elements in DOM order (numbers are indexes into this). */
  function collect() {
    return Array.from(document.querySelectorAll(SELECTOR))
      .filter(isVisible)
      .slice(0, MAX_ELEMENTS);
  }

  function kindOf(raw) {
    switch (raw.tag) {
      case "button":
        return "button";
      case "a":
        return "link";
      case "summary":
        return "summary";
      case "textarea":
        return "text-area";
      case "select":
        return "select";
      case "input":
        if (raw.type === "checkbox") return "checkbox";
        if (raw.type === "radio") return "radio";
        return "text-field";
      default:
        return raw.draggable ? "draggable" : "text-field";
    }
  }

  function labelOf(raw, kind) {
    const named = raw.name ? `input[name="${raw.name}"]` : "";
    const ided = raw.id ? `#${raw.id}` : "";
    switch (kind) {
      case "button":
        return raw.aria || raw.text || raw.value || "button";
      case "link":
        return raw.aria || raw.text || raw.href || "link";
      case "text-field":
        return raw.aria || raw.placeholder || named || ided || "text field";
      case "text-area":
        return raw.aria || ided || "text area";
      case "select":
        return raw.aria || ided || "select";
      case "checkbox":
      case "radio":
        return raw.aria || raw.text || named || kind;
      case "summary":
        return raw.aria || raw.text || "summary";
      case "draggable":
        return raw.aria || raw.text || ided || kind;
      default:
        return `${kind} (no label)`;
    }
  }

  function describe(el) {
    const raw = {
      tag: el.tagName.toLowerCase(),
      aria: el.getAttribute("aria-label") ?? "",
      text: (el.textContent ?? "").trim(),
      value: el.value ?? "",
      placeholder: el.placeholder ?? "",
      name: el.getAttribute("name") ?? "",
      id: el.id ?? "",
      href: el.href ?? "",
      type: el.type ?? "",
      draggable: el.getAttribute("draggable") === "true",
    };
    const kind = kindOf(raw);
    return { kind, label: labelOf(raw, kind).slice(0, 60) };
  }

  function snapshotText() {
    const els = collect();
    const lines = els.map((el, n) => {
      const d = describe(el);
      return `  ${n}) [${d.kind}] ${d.label}`;
    });
    const more =
      els.length < MAX_ELEMENTS
        ? ""
        : `\n  (snapshot capped at ${MAX_ELEMENTS} elements; re-snapshot after acting if you need more)`;
    return `Title: ${document.title || "(untitled)"}\nURL: ${location.href}\nInteractive elements:\n${lines.join("\n")}${more}`;
  }

  /** What every action returns: what it did, then a fresh snapshot. */
  async function withSnapshot(message) {
    await sleep(150); // let the page react (async handlers, framework renders)
    return `${message}\n${snapshotText()}`;
  }

  /** Validate element-number arguments against the current list. */
  function resolveTargets(args, keys) {
    const numbers = keys.map((k) =>
      typeof args[k] === "number" ? Math.trunc(args[k]) : Number.NaN
    );
    if (numbers.some((n) => !Number.isFinite(n))) {
      const plural = keys.length > 1;
      throw new Error(
        `${keys.join(" and ")} ${plural ? "are" : "is"} required (${plural ? "element numbers" : "an element number"})`
      );
    }
    const els = collect();
    return numbers.map((n) => {
      const el = els[n];
      if (!el) {
        throw new Error(
          `no element ${n}; the page has ${els.length} interactive elements (0..${els.length - 1})`
        );
      }
      return { el, n, ...describe(el) };
    });
  }

  function center(el) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function mouse(el, type, p, extra = {}) {
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: p.x,
      clientY: p.y,
      button: 0,
      ...extra,
    };
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    return el.dispatchEvent(new Ctor(type, init));
  }

  // ── Actions ───────────────────────────────────────────────────────────

  async function click(args) {
    const [t] = resolveTargets(args, ["n"]);
    const p = center(t.el);
    t.el.focus?.({ preventScroll: true });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      mouse(t.el, type, p, { buttons: type.endsWith("down") ? 1 : 0 });
    }
    t.el.click();
    return withSnapshot(`Clicked [${t.kind}] "${t.label}".`);
  }

  async function hover(args) {
    const [t] = resolveTargets(args, ["n"]);
    const p = center(t.el);
    // Enter/leave events don't bubble; the rest do.
    for (const type of ["pointerover", "pointerenter", "pointermove"]) {
      mouse(t.el, type, p, { bubbles: type !== "pointerenter" });
    }
    for (const type of ["mouseover", "mouseenter", "mousemove"]) {
      mouse(t.el, type, p, { bubbles: type !== "mouseenter" });
    }
    return withSnapshot(`Hovered over [${t.kind}] "${t.label}".`);
  }

  /** Set a form control's value the way user input does, so frameworks notice. */
  function setValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fill(el, text) {
    el.focus?.({ preventScroll: true });
    if (el.isContentEditable) {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
    } else {
      setValue(el, text);
    }
  }

  function chooseOption(el, text) {
    const options = Array.from(el.options);
    const match =
      options.find((o) => o.label === text || o.textContent.trim() === text) ??
      options.find((o) => o.value === text);
    if (!match) throw new Error(`no option matching "${text}"`);
    el.value = match.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** The focusable elements, in tab order (approximated as DOM order). */
  function focusables() {
    return Array.from(
      document.querySelectorAll(
        'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.disabled && isVisible(el));
  }

  /** Press a key ("Enter", "Tab", "Control+A", "a") on `el`, best effort. */
  function pressKey(el, spec) {
    const parts = spec.split("+");
    const key = parts.pop() || "+";
    const mods = new Set(parts.map((m) => m.toLowerCase()));
    const init = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ctrlKey: mods.has("control") || mods.has("ctrl"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt"),
      metaKey: mods.has("meta"),
    };
    const target = el || document.activeElement || document.body;
    const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
    if (down) {
      const isText =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (key.length === 1 && !init.ctrlKey && !init.metaKey && isText) {
        target.dispatchEvent(new KeyboardEvent("keypress", init));
        setValue(target, target.value + key);
      } else if (key === "Backspace" && isText) {
        setValue(target, target.value.slice(0, -1));
      } else if (key === "Enter") {
        target.dispatchEvent(new KeyboardEvent("keypress", init));
        const form = target.form;
        if (form && target instanceof HTMLInputElement) form.requestSubmit();
      } else if (key === "Tab") {
        const list = focusables();
        const i = list.indexOf(target);
        const next =
          list[(i + (init.shiftKey ? -1 : 1) + list.length) % list.length];
        next?.focus();
      }
    }
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  async function type(args) {
    const key = typeof args.key === "string" ? args.key : "";
    if (key && args.n === undefined && args.text === undefined) {
      pressKey(null, key);
      return withSnapshot(`Pressed ${key}.`);
    }
    const text = typeof args.text === "string" ? args.text : "";
    const [t] = resolveTargets(args, ["n"]);
    const typing = !key || args.text !== undefined;
    if (typing) {
      if (t.kind === "checkbox" || t.kind === "radio") {
        if (!t.el.checked) t.el.click();
      } else if (t.kind === "select") {
        chooseOption(t.el, text);
      } else if (
        t.kind === "text-field" ||
        t.kind === "text-area" ||
        t.kind === "summary"
      ) {
        fill(t.el, text);
      } else {
        throw new Error(
          `element ${t.n} is a [${t.kind}] and cannot be typed into; use browser_click`
        );
      }
    }
    if (key) {
      t.el.focus?.({ preventScroll: true });
      pressKey(t.el, key);
    }
    const on = `[${t.kind}] "${t.label}"`;
    if (!key) return withSnapshot(`Typed "${text}" into ${on}.`);
    return withSnapshot(
      typing
        ? `Typed "${text}" into ${on}, then pressed ${key}.`
        : `Pressed ${key} on ${on}.`
    );
  }

  async function drag(args) {
    const [source, target] = resolveTargets(args, ["from", "to"]);
    const from = center(source.el);
    const to = center(target.el);
    let data;
    try {
      data = new DataTransfer();
    } catch {
      data = undefined;
    }
    const dragEvent = (el, type, p) => {
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: p.x,
        clientY: p.y,
        dataTransfer: data,
      };
      return el.dispatchEvent(new DragEvent(type, init));
    };
    mouse(source.el, "pointerdown", from, { buttons: 1 });
    mouse(source.el, "mousedown", from, { buttons: 1 });
    dragEvent(source.el, "dragstart", from);
    mouse(target.el, "mousemove", to, { buttons: 1 });
    dragEvent(target.el, "dragenter", to);
    dragEvent(target.el, "dragover", to);
    dragEvent(target.el, "drop", to);
    dragEvent(source.el, "dragend", to);
    mouse(target.el, "mouseup", to);
    mouse(target.el, "pointerup", to);
    const s = source;
    const d = target;
    return withSnapshot(
      `Dragged [${s.kind}] "${s.label}" onto [${d.kind}] "${d.label}".`
    );
  }

  async function read() {
    const text = (document.body?.innerText ?? "").trim();
    const shown =
      text.length <= MAX_TEXT
        ? text
        : `${text.slice(0, MAX_TEXT)}\n(truncated at ${MAX_TEXT} characters)`;
    return `Title: ${document.title || "(untitled)"}\nURL: ${location.href}\nPage text:\n${shown}`;
  }

  const handlers = {
    browser_snapshot: async () => snapshotText(),
    browser_click: click,
    browser_hover: hover,
    browser_type: type,
    browser_drag: drag,
    browser_read: read,
  };

  browser.runtime.onMessage.addListener((msg) => {
    const handler = handlers[msg?.tool];
    if (!handler) {
      return Promise.resolve({
        ok: false,
        error: `${msg?.tool} is not available while driving Firefox`,
      });
    }
    return handler(msg.args ?? {}).then(
      (text) => ({ ok: true, text }),
      (err) => ({
        ok: false,
        error: String(err && err.message ? err.message : err),
      })
    );
  });
})();
