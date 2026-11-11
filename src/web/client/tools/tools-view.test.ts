import { expect, test } from "bun:test";
import type { ToolSwitch } from "../../../protocol/protocol.ts";
import { groupsOf, sourceOf } from "./tools-view.ts";

test("an MCP tool belongs to its server, and every other tool to the built-in group", () => {
  expect(sourceOf("rea__comment")).toBe("rea");
  expect(sourceOf("list_files")).toBe("built-in tools");
});

test("tools are grouped by source in the order each source first appears", () => {
  const tools: ToolSwitch[] = [
    { name: "rea__comment", enabled: true },
    { name: "list_files", enabled: false },
    { name: "rea__xrefs", enabled: true },
  ];
  expect(groupsOf(tools)).toEqual([
    { name: "rea", tools: [tools[0], tools[2]] },
    { name: "built-in tools", tools: [tools[1]] },
  ]);
});
