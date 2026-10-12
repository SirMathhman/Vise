import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** No directory holds this many `.ts` files directly; group them into sub-directories. */
const LIMIT = 10;

const SKIPPED = new Set(["node_modules", "dist", "out", ".git", ".vise", "packages"]);

/** The repository, wherever the tests are started from. (File sizes are enforced by `bun run lint`.) */
const ROOT = join(import.meta.dir, "..");

/** Every directory under `dir` with how many `.ts` files sit directly in it. */
function counts(dir: string, found: Map<string, number> = new Map()) {
  const entries = readdirSync(dir, { withFileTypes: true });
  found.set(
    dir,
    entries.filter((e) => e.isFile() && e.name.endsWith(".ts")).length,
  );
  for (const e of entries) {
    if (e.isDirectory() && !SKIPPED.has(e.name))
      counts(join(dir, e.name), found);
  }
  return found;
}

test(`no directory has ${LIMIT} or more .ts files`, () => {
  const crowded = [...counts(ROOT)]
    .filter(([, n]) => n >= LIMIT)
    .map(([dir, n]) => `${dir}: ${n}`);
  expect(crowded).toEqual([]);
});
