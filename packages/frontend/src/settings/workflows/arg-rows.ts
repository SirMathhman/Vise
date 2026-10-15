import { make } from "../../dom.ts";
/** One argument a tool takes. */
export interface ToolParam {
  name: string;
  required: boolean;
  description: string;
}

/** A tool and the arguments it takes. */
export interface ToolInfo {
  name: string;
  params: ToolParam[];
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

type Mode = "unset" | "fixed" | "model";

/** How a saved value reads as a row. A step from before arguments could be fixed treated its values as hints. */
function initial(
  param: ToolParam,
  args: Record<string, unknown>,
  exact: boolean,
): { mode: Mode; text: string } {
  if (!(param.name in args)) {
    return { mode: param.required ? "model" : "unset", text: "" };
  }
  const value = args[param.name];
  const hint = hintOf(value);
  if (exact && hint === undefined) return { mode: "fixed", text: shown(value) };
  return { mode: "model", text: hint ?? (exact ? "" : shown(value)) };
}

/**
 * The argument rows of a tool step: one per argument the tool takes (the names
 * are not editable), each "not set" (optional ones only), a "fixed value", or
 * "model provides" with an optional hint for the model. Arguments in `args`
 * that the tool does not take are kept as extra rows so they can be seen and
 * removed ("not set").
 */
export function createArgRows(
  box: HTMLElement,
  params: ToolParam[],
  args: Record<string, unknown>,
  exact: boolean,
) {
  box.textContent = "";
  const known = new Set(params.map((p) => p.name));
  const extras: ToolParam[] = Object.keys(args)
    .filter((name) => !known.has(name))
    .map((name) => ({
      name,
      required: false,
      description: "(not an argument of this tool)",
    }));
  const rows = [...params, ...extras].map((param) => {
    const start = initial(param, args, exact);
    const row = make("div", "actions");
    const label = make("span");
    label.textContent = param.required ? `${param.name} *` : param.name;
    label.title = param.description;
    const mode = make("select", "field");
    if (!param.required) mode.append(new Option("Not set", "unset"));
    mode.append(new Option("Fixed value", "fixed"));
    mode.append(new Option("Model provides", "model"));
    mode.value = start.mode;
    const text = make("input", "field");
    text.value = start.text;
    const refresh = (): void => {
      text.hidden = mode.value === "unset";
      text.placeholder =
        mode.value === "model"
          ? "hint for the model (optional)"
          : "value ({{input}} = the workflow's input)";
    };
    mode.addEventListener("change", refresh);
    refresh();
    row.append(label, mode, text);
    box.append(row);
    return { name: param.name, mode, text };
  });
  return {
    /** The arguments as saved; unset ones are left out. */
    read(): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      for (const { name, mode, text } of rows) {
        if (mode.value === "unset") continue;
        result[name] = mode.value === "model" ? { $model: text.value } : fixedValue(text.value);
      }
      return result;
    },
  };
}
