import { expect, test } from "bun:test";
import { classifyLine } from "./commands.ts";

test("recognises /exit and /context after trimming and keeps other lines as messages", () => {
  expect(classifyLine("  /exit  ")).toEqual({ kind: "exit" });
  expect(classifyLine("/context")).toEqual({ kind: "context" });
  expect(classifyLine("/foo")).toEqual({ kind: "unknown-command", command: "/foo" });
  expect(classifyLine("exit")).toEqual({ kind: "message", text: "exit" });
  expect(classifyLine("quit")).toEqual({ kind: "message", text: "quit" });
});

test("reads /note and its words, but not a word that only starts with note", () => {
  expect(classifyLine("  /note new work plan ")).toEqual({ kind: "note", words: ["new", "work", "plan"] });
  expect(classifyLine("/note")).toEqual({ kind: "note", words: [] });
  expect(classifyLine("/notes")).toEqual({ kind: "unknown-command", command: "/notes" });
});
