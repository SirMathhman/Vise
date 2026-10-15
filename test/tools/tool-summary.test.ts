import { expect, test } from "bun:test";
import { summarizeToolResult, toolDetail } from "../../packages/backend/src/output/tool-line.ts";

test("a read says which lines it returned", () => {
  expect(summarizeToolResult("read_file", "[lines 40-159 of 900]\nabc")).toBe(
    "lines 40–159 of 900",
  );
  expect(summarizeToolResult("read_file", "a\nb\nc")).toBe("3 lines");
  expect(summarizeToolResult("read_temp", "[find-3: lines 1-250 of 800]\nx")).toBe(
    "lines 1–250 of 800",
  );
});

test("a read that asks for a range shows it when it starts", () => {
  expect(toolDetail({ path: "a.ts", offset: 40, limit: 120 }, "read_file")).toBe(
    "a.ts · lines 40–159",
  );
  expect(toolDetail({ path: "a.ts", offset: 10 }, "read_file")).toContain("lines 10–");
  expect(toolDetail({ path: "a.ts" }, "read_file")).toBe("a.ts");
});

test("a search says how many it found, even when the result was too long to show", () => {
  expect(summarizeToolResult("search_files", "a:1: x\nb:2: y")).toBe("2 matches");
  expect(summarizeToolResult("search_files", "a:1: x")).toBe("1 match");
  expect(summarizeToolResult("search_files", "no matches")).toBe("no matches");
  expect(
    summarizeToolResult(
      "search_files",
      "p\n[... output too large to show: 480 lines, 9000 characters. Saved as x]",
    ),
  ).toBe("480 matches");
  expect(
    summarizeToolResult("search_temp", "x:1: a\nx:2: b\n[5 more matches: narrow the pattern]"),
  ).toBe("7 matches");
  expect(summarizeToolResult("find_files", "only/one.ts")).toBe("1 file");
});

test("a failure is shown short, and a tool with nothing to say shows nothing", () => {
  expect(summarizeToolResult("read_file", "error: no such file")).toBe("error: no such file");
  expect(summarizeToolResult("create_file", "created x")).toBeUndefined();
});
