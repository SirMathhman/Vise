import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { newNameProblem, RESERVED_COMMAND_NAMES } from "../../src/repl/commands/registry.ts";

test("every built-in slash command in the session table is reserved", () => {
  const source = readFileSync("src/repl/session.ts", "utf8");
  const names = [...source.matchAll(/name: "\/([a-z]+)"/g)].map((m) => m[1] as string);
  expect(names.length).toBeGreaterThan(10);
  for (const name of names) expect(RESERVED_COMMAND_NAMES).toContain(name);
});

test("a new item cannot take a built-in's name or contain whitespace", () => {
  expect(newNameProblem("help")).toContain("built-in");
  expect(newNameProblem("exit")).toContain("built-in");
  expect(newNameProblem("my notes")).toContain("whitespace");
  expect(newNameProblem("deploy")).toBeUndefined();
});
