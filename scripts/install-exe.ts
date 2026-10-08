import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Put a freshly built exe in place of the final one without ever touching a
 * running copy. Windows refuses to overwrite or delete a running exe but allows
 * it to be renamed, so the old file is moved aside as `<final>.<time>.old` and
 * the new one takes its name. A running Vise therefore keeps working (and can
 * rebuild itself) until it is restarted. Returns true when the previous exe was
 * kept aside.
 */
export function installExe(next: string, final: string): boolean {
  removeOldCopies(final);
  const old = `${final}.${Date.now()}.old`;
  const hadFinal = existsSync(final);
  if (hadFinal) renameSync(final, old);
  try {
    renameSync(next, final);
  } catch (e) {
    if (hadFinal) renameSync(old, final);
    throw e;
  }
  return hadFinal;
}

/** Delete earlier generations that nothing runs any more; a running one is left alone. */
function removeOldCopies(final: string): void {
  const dir = dirname(final);
  const prefix = `${basename(final)}.`;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".old")) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // still running (locked): it goes with a later build
    }
  }
}
