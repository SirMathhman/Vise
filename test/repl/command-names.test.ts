import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMMANDS, helpLines } from "../../src/repl/command-catalog.ts";
import { newNameProblem, RESERVED_COMMAND_NAMES } from "../../src/repl/commands/registry.ts";

/** The slash names of the session's dispatch table (`Session.commands`). */
function dispatched(): string[] {
  const source = readFileSync("src/repl/session.ts", "utf8");
  return [...source.matchAll(/name: "\/([a-z]+)"/g)].map((m) => m[1] as string);
}

test("the catalog and the session's dispatch table list the same commands", () => {
  const table = dispatched();
  expect(table.length).toBeGreaterThan(10);
  const catalog = COMMANDS.filter((c) => !c.webOnly).map((c) => c.name.slice(1));
  expect([...table].sort()).toEqual([...catalog].sort());
});

test("web-only commands are reserved and shown in the page's help only", () => {
  expect(RESERVED_COMMAND_NAMES).toContain("steer");
  expect(RESERVED_COMMAND_NAMES).toContain("queue");
  const none = new Set<never>();
  expect(helpLines(none, false).join("\n")).not.toContain("/steer");
  expect(helpLines(none, true).join("\n")).toContain("/steer");
});

test("help hides a command whose need is not met", () => {
  expect(helpLines(new Set(), false).join("\n")).not.toContain("/model");
  expect(helpLines(new Set(["model"]), false).join("\n")).toContain("/model");
});

test("a new item cannot take a built-in's name or contain whitespace", () => {
  expect(newNameProblem("help")).toContain("built-in");
  expect(newNameProblem("exit")).toContain("built-in");
  expect(newNameProblem("my notes")).toContain("whitespace");
  expect(newNameProblem("deploy")).toBeUndefined();
});
