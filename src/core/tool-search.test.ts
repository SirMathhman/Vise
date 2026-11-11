import { expect, test } from "bun:test";
import { SEARCH_LIMIT, parseSearchQuery, searchTools } from "./tool-search.ts";
import type { ToolSpec } from "./tools.ts";

function spec(name: string, description: string): ToolSpec {
  return { type: "function", function: { name, description, parameters: {} } };
}

test("a search returns the tools whose name or description holds every word, ignoring case, up to the limit", () => {
  const specs = [spec("rea__comment", "Set a Comment"), spec("rea__xrefs", "list xrefs"), spec("tavily__search", "web")];
  expect(searchTools(specs, "COMMENT").map((s) => s.function.name)).toEqual(["rea__comment"]);
  expect(searchTools(specs, "rea xrefs").map((s) => s.function.name)).toEqual(["rea__xrefs"]);
  expect(searchTools(specs, "   ")).toEqual([]);
  const many = Array.from({ length: SEARCH_LIMIT + 5 }, (_, index) => spec(`x__t${index}`, "shared"));
  expect(searchTools(many, "shared")).toHaveLength(SEARCH_LIMIT);
});

test("a search query must be text in a JSON object", () => {
  expect(parseSearchQuery('{"query":"comment"}')).toEqual({ ok: true, value: "comment" });
  expect(parseSearchQuery('{"query":3}').ok).toBe(false);
  expect(parseSearchQuery("not json").ok).toBe(false);
});
