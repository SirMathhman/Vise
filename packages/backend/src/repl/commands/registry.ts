import type { ViseError } from "@vise/core";
import { COMMAND_NAMES } from "../command-catalog.ts";
import type { LineResult } from "../ports.ts";

/** One built-in slash command: its name, and what it does with the whole line. */
export interface BuiltinCommand {
  name: string;
  /** Matches the bare name only (`/new`), never `/new something`. */
  exact?: boolean;
  run: (line: string) => LineResult | Promise<LineResult>;
}

/**
 * Names a note, profile or workflow must not take: a `/name` shortcut would
 * never reach it (a built-in answers first), or the web page handles it itself.
 * They are the catalog's commands (`command-catalog.ts`).
 */
export const RESERVED_COMMAND_NAMES: readonly string[] = COMMAND_NAMES;

/** Why `name` cannot be given to a new note, profile or workflow (it would be unreachable or shadowed), or undefined when it can. */
export function newNameProblem(name: string): string | undefined {
  if (/\s/.test(name)) return `'${name}' contains whitespace, which '/${name}' could not reach`;
  if (RESERVED_COMMAND_NAMES.includes(name)) {
    return `'${name}' is the name of a built-in command; choose another`;
  }
  return undefined;
}

/** The built-in command a line invokes, if any. A name that is not in the table is open to notes and workflows (`shortcut-command.ts`). */
export function findBuiltin(
  table: BuiltinCommand[],
  line: string,
): BuiltinCommand | undefined {
  return table.find(({ name, exact }) =>
    exact ? line === name : line === name || line.startsWith(`${name} `),
  );
}

/** The error a command gives when the frontend wired no support for its feature. */
export function unsupported(feature: string): { ok: false; error: ViseError } {
  return {
    ok: false,
    error: { kind: "malformed", body: `${feature} not supported by the current client` },
  };
}
