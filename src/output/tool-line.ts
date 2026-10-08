import { config } from "../config.ts";
import type { Picture } from "../core/errors.ts";

/**
 * How a tool call is shown to the user: an icon, the tool's name and a short
 * detail taken from its arguments (the tab, the address, the path, the
 * command...). Pure; shared by the terminal display and the web server.
 */

/** How a tool is shown: a readable name and an icon (a `Tool`'s `display`). */
export interface ToolDisplay {
  label: string;
  icon: string;
}

/** Finds a tool's display by its name (the edge builds it from the tool definitions; see `tools/display.ts`). */
export type DisplayLookup = (name: string) => ToolDisplay | undefined;

/** The arguments worth showing, in display order (long bodies and code are left out). */
const SHOWN = [
  "url",
  "path",
  "paths",
  "from_ref",
  "to_ref",
  "ref",
  "command",
  "pattern",
  "root",
  "query",
  "scope",
  "category",
  "name",
  "task",
  "question",
  "text",
  "key",
] as const;


function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Arguments whose value is never echoed (it may be a password): only its length is shown. */
const SENSITIVE: Record<string, string> = { browser_type: "text" };

function partOf(key: string, value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length > 0 ? clip(items.join(", "), config.toolLinePartMax) : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const shown = clip(value, config.toolLinePartMax);
  return key === "text" ? JSON.stringify(shown) : shown;
}

/** A short description of what a call does, from its arguments ("" when there is nothing to show). */
export function toolDetail(
  args: Record<string, unknown> | undefined,
  name = "",
): string {
  if (!args) return "";
  const parts: string[] = [];
  if (typeof args["tab"] === "number") parts.push(`tab ${args["tab"]}`);
  for (const key of SHOWN) {
    const hidden = SENSITIVE[name] === key && typeof args[key] === "string";
    const part = hidden
      ? `${(args[key] as string).length} characters`
      : partOf(key, args[key]);
    if (part) parts.push(part);
  }
  return clip(parts.join(" · "), config.toolLineDetailMax);
}

/** A readable name made from an identifier, for a tool that declares no display of its own: `read_file` is "Read file". */
export function toolLabel(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words === "" ? name : words[0]!.toUpperCase() + words.slice(1);
}

/** The one-line form: `<icon> <Name> · <detail>`; a tool with no display of its own gets a wrench and a name made from its identifier. */
export function formatToolCall(
  name: string,
  args?: Record<string, unknown>,
  displayOf?: DisplayLookup,
): string {
  const shown = displayOf?.(name) ?? { label: toolLabel(name), icon: "🔧" };
  const detail = toolDetail(args, name);
  return `${shown.icon} ${shown.label}${detail ? ` · ${detail}` : ""}`;
}

/** The one-line form of a picture shown to the user: `📷 <label> · <width>x<height> · <size> KB`. */
export function formatPicture(picture: Picture): string {
  const size =
    picture.width && picture.height
      ? ` · ${picture.width}x${picture.height}`
      : "";
  const kb = Math.max(1, Math.round(picture.bytes / 1000));
  return `📷 ${picture.label}${size} · ${kb} KB`;
}
