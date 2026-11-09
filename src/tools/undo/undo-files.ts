import { readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { err, ok, type Result, type UndoStore } from "../../core/messages.ts";
import {
  type Bytes,
  createLog,
  dropTurns,
  planRevert,
  pointsOf,
  recordAfter,
  recordBefore,
  startTurn,
  type UndoLog,
} from "./undo-log.ts";

// The bytes of a file, or nothing when there is no file. Any other failure is reported.
async function readBytes(path: string): Promise<Result<Bytes>> {
  try {
    return ok(new Uint8Array(await readFile(path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok(undefined);
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

function sameBytes(a: Bytes, b: Bytes): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((byte, index) => byte === b[index]);
}

// Runs a change to a file and records what it did, so a later revert can put the bytes back. The bytes are
// read before the change, and what the file holds afterwards is recorded whether or not the change succeeded.
// A change whose file cannot be read first is not run.
async function around(
  root: string,
  log: UndoLog,
  path: string,
  run: () => Promise<string>,
): Promise<string> {
  const target = resolve(root, path);
  const before = await readBytes(target);
  if (!before.ok) return `error: ${before.error.message}`;
  recordBefore(log, target, before.value);
  try {
    return await run();
  } finally {
    const after = await readBytes(target);
    if (after.ok) recordAfter(log, target, after.value);
  }
}

// Puts the files back to the start of the turn that is `turnsBack` back. Nothing changes when a file no
// longer holds what Vise last wrote to it, so a change made outside Vise is never overwritten.
async function revertFiles(root: string, log: UndoLog, turnsBack: number): Promise<Result<string[]>> {
  const plan = planRevert(log, turnsBack);
  if (plan === undefined) return err(new Error(`there is no undo point ${turnsBack} turns back`));
  const changedOutside: string[] = [];
  for (const path of plan.keys()) {
    const current = await readBytes(path);
    if (!current.ok || !sameBytes(current.value, log.expected.get(path))) {
      changedOutside.push(relative(root, path));
    }
  }
  if (changedOutside.length > 0) {
    return err(new Error(`changed since Vise last wrote them, so nothing was undone: ${changedOutside.join(", ")}`));
  }
  const restored: string[] = [];
  for (const [path, bytes] of plan) {
    try {
      if (bytes === undefined) await rm(path, { force: true });
      else await writeFile(path, bytes);
    } catch (error) {
      return err(new Error(`could not restore ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`));
    }
    log.expected.set(path, bytes);
    restored.push(relative(root, path));
  }
  dropTurns(log, turnsBack);
  return ok(restored);
}

// The undo store for a working directory: changes are recorded through it, and /undo reverts through it.
export function undoStore(root: string): UndoStore {
  const log = createLog();
  return {
    startTurn: () => startTurn(log),
    points: () => pointsOf(log),
    revert: (turnsBack) => revertFiles(root, log, turnsBack),
    around: (path, run) => around(root, log, path, run),
  };
}
