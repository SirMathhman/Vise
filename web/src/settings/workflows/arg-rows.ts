/** An argument of a tool step: a fixed value, or one the model supplies (with a hint for it). */
export type ArgValue = unknown;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

/** The text a fixed value is shown as: strings as they are, anything else as JSON. */
const shown = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** A fixed value from its text: JSON when it is not a string (`3`, `true`, `{...}`), otherwise the text itself. */
function fixedValue(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "string") return parsed;
  } catch {
    // not JSON: it is a plain string
  }
  return text;
}

function hintOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const hint = (value as Record<string, unknown>)["$model"];
  return typeof hint === "string" ? hint : undefined;
}

/**
 * The argument rows of a tool step: name, "fixed" or "model provides", and the
 * value (fixed) or the hint for the model. A step written before arguments
 * could be fixed treated its values as hints, so those load as model-provided.
 */
export function createArgRows(
  box: HTMLElement,
  args: Record<string, unknown>,
  exact: boolean,
) {
  const rows: { row: HTMLElement; read: () => [string, unknown] }[] = [];
  function add(name: string, value: unknown): void {
    const row = make("div", "save-row");
    const key = make("input", "save-input");
    key.placeholder = "argument";
    key.value = name;
    const mode = make("select", "save-input");
    mode.append(new Option("fixed value", "fixed"));
    mode.append(new Option("model provides", "model"));
    const hint = hintOf(value);
    const isModel = exact ? hint !== undefined : true;
    mode.value = isModel ? "model" : "fixed";
    const text = make("input", "save-input");
    if (isModel) text.value = hint ?? (exact ? "" : shown(value));
    else text.value = shown(value);
    const label = (): void => {
      text.placeholder =
        mode.value === "model" ? "hint for the model (optional)" : "value";
    };
    mode.addEventListener("change", label);
    label();
    const remove = make("button", "tools-btn");
    remove.type = "button";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", "Remove argument");
    const entry = {
      row,
      read: (): [string, unknown] => [
        key.value.trim(),
        mode.value === "model"
          ? { $model: text.value }
          : fixedValue(text.value),
      ],
    };
    remove.addEventListener("click", () => {
      rows.splice(rows.indexOf(entry), 1);
      row.remove();
    });
    row.append(key, mode, text, remove);
    rows.push(entry);
    box.append(row);
  }
  for (const [name, value] of Object.entries(args)) add(name, value);
  return {
    add: (): void => add("", ""),
    /** The arguments as saved; a blank or repeated name is an error for the user. */
    read(): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      for (const entry of rows) {
        const [name, value] = entry.read();
        if (name === "") throw new Error("an argument has no name");
        if (name in result) throw new Error(`argument '${name}' is given twice`);
        result[name] = value;
      }
      return result;
    },
  };
}
