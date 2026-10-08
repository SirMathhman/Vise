import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applySettings, fileValue, SPEC } from "./config.ts";
import type { Spec } from "./config.ts";
import { globalDataDir } from "./data-dir.ts";

/** The user's settings file: shared by every project, outside any dev directory. */
export const settingsPath = join(globalDataDir, ".env");

const HEADER =
  "# Vise settings. Edited from the settings page (or by hand); a missing or empty value uses the default.\n";

/** `NAME=value` lines (comments and blank lines skipped). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) out[match[1]!] = match[2]!.trim();
  }
  return out;
}

function readValues(path: string): Record<string, string> {
  try {
    return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

/** Read the settings file (if there is one) and make its values the live settings. */
export function loadSettingsFile(path = settingsPath): void {
  applySettings(readValues(path));
}

/** An error for a value that setting would not accept, else undefined. */
function problem(spec: Spec, value: string): string | undefined {
  if (/[\r\n]/.test(value)) return `${spec.label}: must be one line`;
  if (typeof spec.def === "string") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < (spec.min ?? 0)) {
    return `${spec.label}: needs a number of at least ${spec.min ?? 0}`;
  }
  return undefined;
}

/**
 * Save the values the page sent (variable name to text; "" means the default)
 * and apply them at once. Unknown names are refused; a secret that comes back
 * empty is left as it was. Lines of the file that are not Vise settings are kept.
 * Returns an error message, or undefined when saved.
 */
export function saveSettings(
  values: Record<string, string>,
  path = settingsPath,
): string | undefined {
  const specs = new Map(Object.values(SPEC).map((s: Spec) => [s.env, s]));
  const next = readValues(path);
  for (const [name, raw] of Object.entries(values)) {
    const spec = specs.get(name);
    if (!spec) return `unknown setting ${name}`;
    const value = raw.trim();
    if (spec.secret && value === "") continue;
    const bad = value === "" ? undefined : problem(spec, value);
    if (bad) return bad;
    if (value === "") delete next[name];
    else next[name] = value;
  }
  const others = existsSync(path)
    ? readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((l) => {
          const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1];
          return name !== undefined && !specs.has(name);
        })
    : [];
  const lines = Object.entries(next)
    .filter(([name]) => specs.has(name))
    .map(([name, value]) => `${name}=${value}`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${HEADER}${[...lines, ...others].join("\n")}\n`);
    renameSync(temp, path);
  } catch (error) {
    return `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
  applySettings(next);
  return undefined;
}

/** The settings as the page shows them (secrets are never sent, only whether one is set). */
export function describeSettings(): {
  path: string;
  fields: {
    env: string;
    group: string;
    label: string;
    kind: "text" | "number";
    def: string | number;
    min?: number;
    value: string;
    secret: boolean;
    set: boolean;
    restart: boolean;
  }[];
} {
  return {
    path: settingsPath,
    fields: Object.values(SPEC).map((spec: Spec) => ({
      env: spec.env,
      group: spec.group,
      label: spec.label,
      kind: typeof spec.def === "string" ? "text" : "number",
      def: spec.secret ? "" : spec.def,
      ...(spec.min === undefined ? {} : { min: spec.min }),
      value: spec.secret ? "" : fileValue(spec),
      secret: spec.secret === true,
      set: fileValue(spec) !== "",
      restart: spec.restart === true,
    })),
  };
}
