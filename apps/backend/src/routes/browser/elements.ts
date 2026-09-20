/**
 * The pure element-classification layer of the browser session: which page
 * elements a snapshot lists, and how each is classified and labelled for the
 * model. Nothing here touches Playwright, so it is testable without a browser.
 */

/** The maximum number of interactive elements a snapshot lists (output bound). */
export const MAX_SNAPSHOT_ELEMENTS = 100;

/**
 * The CSS selector for the interactive elements a snapshot lists. Restricted
 * to elements the model can meaningfully click or type into: buttons, links,
 * text inputs, textareas, selects, ARIA button/link roles, `<summary>`
 * toggles, contenteditable fields, and draggable elements. Hidden inputs are
 * excluded.
 */
export const INTERACTIVE_SELECTOR =
  "button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=link], [contenteditable=true], summary, [draggable=true]";

/** The model-facing kind of an interactive element (drives label + action). */
export type ElementKind =
  | "button"
  | "link"
  | "text-field"
  | "text-area"
  | "select"
  | "checkbox"
  | "radio"
  | "summary"
  | "draggable";

/** The raw properties read from a live element, used to build its label/kind. */
export interface RawElement {
  tag: string;
  aria: string;
  text: string;
  value: string;
  placeholder: string;
  name: string;
  id: string;
  href: string;
  type: string;
  draggable: boolean;
}

/**
 * The shape of a live browser element as read inside the page context. Named
 * separately from RawElement because the backend has no DOM lib (no global
 * HTMLElement/HTMLInputElement), so the element is cast to this structural
 * type instead of a DOM type.
 */
export interface BrowserElement {
  tagName: string;
  getAttribute(name: string): string | null;
  textContent: string | null;
  value: string;
  placeholder: string;
  name: string;
  id: string;
  href: string;
  type: string;
}

/** A single snapshot entry: the model-facing number, kind, and label. */
export interface SnapshotEntry {
  n: number;
  kind: ElementKind;
  label: string;
}

/**
 * Classify an element by its tag/role/type into the model-facing kind.
 */
export function kindOf(raw: RawElement): ElementKind {
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

/**
 * Build the short model-facing label for an element: the most human-meaningful
 * text available (aria-label, visible text, placeholder, name, id, href),
 * truncated so a chatty page can't bloat the snapshot.
 */
export function labelOf(raw: RawElement, kind: ElementKind): string {
  const fallback = `${kind} (no label)`;
  switch (kind) {
    case "button":
      return raw.aria || raw.text || raw.value || "button";
    case "link":
      return raw.aria || raw.text || raw.href || "link";
    case "text-field":
      return (
        raw.aria ||
        raw.placeholder ||
        (raw.name ? `input[name="${raw.name}"]` : "") ||
        (raw.id ? `#${raw.id}` : "") ||
        "text field"
      );
    case "text-area":
      return raw.aria || (raw.id ? `#${raw.id}` : "") || "text area";
    case "select":
      return raw.aria || (raw.id ? `#${raw.id}` : "") || "select";
    case "checkbox":
    case "radio":
      return (
        raw.aria ||
        raw.text ||
        (raw.name ? `input[name="${raw.name}"]` : "") ||
        kind
      );
    case "summary":
      return raw.aria || raw.text || "summary";
    case "draggable":
      return raw.aria || raw.text || (raw.id ? `#${raw.id}` : "") || kind;
    default:
      return fallback;
  }
}
