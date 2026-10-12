import { describe, expect, test } from "bun:test";
import { parseServer } from "../../packages/backend/src/mcp/mcp-config.ts";
import { McpHub } from "../../packages/backend/src/mcp/mcp-hub.ts";
import { startHttpFixture } from "./http-fixture.ts";

describe("url servers: configuration", () => {
  test("a url entry needs an http(s) address and string headers", () => {
    expect(parseServer({ url: "https://example.com/mcp", headers: { A: "b" } })).toEqual({
      url: "https://example.com/mcp",
      headers: { A: "b" },
    });
    expect(typeof parseServer({ url: "ftp://x" })).toBe("string");
    expect(typeof parseServer({ url: "not a url" })).toBe("string");
    expect(typeof parseServer({ url: "http://x", headers: { A: 1 } })).toBe("string");
    expect(typeof parseServer({ url: "http://x", command: "npx" })).toBe("string");
  });
});

async function connect(mode: "streamable" | "sse", headers: Record<string, string>) {
  const fixture = await startHttpFixture(mode);
  const hub = new McpHub(import.meta.dir, {
    servers: { remote: { url: fixture.url, headers } },
    problems: [],
  });
  await hub.start();
  return { hub, fixture };
}

describe("url servers: connecting", () => {
  for (const mode of ["streamable", "sse"] as const) {
    test(`${mode}: connects with the headers and calls a tool`, async () => {
      const { hub, fixture } = await connect(mode, { Authorization: "Bearer secret" });
      try {
        expect(hub.status()[0]?.status.state).toBe("ready");
        expect(hub.tools().map((t) => t.function.name)).toEqual(["mcp__remote__echo"]);
        const result = await hub.handlers()["mcp__remote__echo"]!({ text: "hi" });
        expect(result).toBe("echo: hi");
      } finally {
        await hub.close();
        await fixture.close();
      }
    });

    test(`${mode}: without the credentials the server is reported as failed`, async () => {
      const { hub, fixture } = await connect(mode, {});
      try {
        const [server] = hub.status();
        expect(server?.status.state).toBe("failed");
        expect(hub.tools()).toEqual([]);
      } finally {
        await hub.close();
        await fixture.close();
      }
    });
  }
});
