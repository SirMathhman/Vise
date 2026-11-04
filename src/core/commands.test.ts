import { expect, test } from "bun:test";
import { classifyLine } from "./commands.ts";

test("recognises /exit and /context after trimming and keeps other lines as messages", () => {
  expect(classifyLine("  /exit  ")).toEqual({ kind: "exit" });
  expect(classifyLine("/context")).toEqual({ kind: "context" });
  expect(classifyLine("/foo")).toEqual({ kind: "unknown-command", command: "/foo" });
  expect(classifyLine("exit")).toEqual({ kind: "message", text: "exit" });
  expect(classifyLine("quit")).toEqual({ kind: "message", text: "quit" });
});
