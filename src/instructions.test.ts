import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstructions } from "./instructions.ts";

test("returns the text of AGENTS.md in the directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vise-instructions-"));
  await writeFile(join(directory, "AGENTS.md"), "be brief\n");
  expect(await readInstructions(directory)).toBe("be brief\n");
});

test("returns undefined when AGENTS.md is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vise-instructions-"));
  expect(await readInstructions(directory)).toBeUndefined();
});

test("returns undefined when AGENTS.md is blank", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vise-instructions-"));
  await writeFile(join(directory, "AGENTS.md"), "  \n");
  expect(await readInstructions(directory)).toBeUndefined();
});
