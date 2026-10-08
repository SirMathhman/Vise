import type { LineResult } from "./workflow-commands.ts";

/** One built-in slash command: its name, and what it does with the whole line. */
export interface BuiltinCommand {
  name: string;
  /** Matches the bare name only (`/new`), never `/new something`. */
  exact?: boolean;
  run: (line: string) => LineResult | Promise<LineResult>;
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
