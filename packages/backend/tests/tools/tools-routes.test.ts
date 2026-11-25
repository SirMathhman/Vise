import { describe, expect, test } from "bun:test";
import { ToolsResponseSchema, parseJson } from "common";
import { handleTools } from "../../src/tools/tools-routes";

describe("GET /api/tools", () => {
  test("GET returns the tool list, and POST is refused with 405", async () => {
    const listed = handleTools(new Request("http://127.0.0.1:3000/api/tools"));
    expect(listed.status).toBe(200);
    const parsed = parseJson(ToolsResponseSchema, await listed.text());
    expect(parsed.ok && parsed.value.tools.map((t) => t.name)).toContain(
      "read_file",
    );
    const refused = handleTools(
      new Request("http://127.0.0.1:3000/api/tools", { method: "POST" }),
    );
    expect(refused.status).toBe(405);
  });
});
