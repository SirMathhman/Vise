import { existsSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.ts";

/**
 * When run from source, a message telling which build to run if `file`
 * (relative to the repo root, e.g. `web/dist/app.js`) is missing; undefined
 * when it is there or in a compiled build, which carries its files inside.
 */
export function missingBuildOutput(file: string, command: string): string | undefined {
  if (VERSION !== "dev") return undefined;
  return existsSync(join(import.meta.dir, "..", "..", "..", "..", file))
    ? undefined
    : `${file} is missing: run \`${command}\` first.`;
}
