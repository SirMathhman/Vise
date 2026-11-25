import { describe, expect, test } from "bun:test";
import { listTools } from "../../src/tools";

describe("listTools", () => {
  test("names every tool the model may call, each with a description", () => {
    const tools = listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).toContain("start_subagent");
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});
