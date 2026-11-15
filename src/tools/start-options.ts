import { err, ok, type Result } from "./messages.ts";

const FLAG = "--max-rounds";

// The round cap a start names with --max-rounds N or --max-rounds=N. Undefined when the flag is absent. The
// value must be a whole number of at least 1.
export function maxRoundsOf(args: string[]): Result<number | undefined> {
  const at = args.findIndex((arg) => arg === FLAG || arg.startsWith(`${FLAG}=`));
  if (at < 0) return ok(undefined);
  const word = args[at] === FLAG ? args[at + 1] : args[at]?.slice(FLAG.length + 1);
  const value = word === undefined ? Number.NaN : Number(word);
  if (!Number.isInteger(value) || value < 1)
    return err(new Error(`${FLAG} needs a whole number of at least 1`));
  return ok(value);
}
