import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServers, parseServer } from "../../packages/backend/src/mcp/mcp-config.ts";
import { McpHub } from "../../packages/backend/src/mcp/mcp-hub.ts";
import { formatResult, toolName } from "../../packages/backend/src/mcp/mcp-tools.ts";
import { formatMcpStatus, mcpNote } from "../../packages/backend/src/output/mcp-format.ts";

const fixture = join(import.meta.dir, "fixture-server.ts");
const spec = { command: process.execPath, args: [fixture], env: {} };

describe("mcp config", () => {
  test("parseServer accepts stdio entries and refuses the rest", () => {
    expect(parseServer({ command: "npx", args: ["-y", "x"] })).toEqual({
      command: "npx",
      args: ["-y", "x"],
      env: {},
    });
    expect(typeof parseServer({ url: "ftp://x" })).toBe("string");
    expect(typeof parseServer({ command: "a", args: [1] })).toBe("string");
  });

  test("project entries override global ones; bad and disabled entries are dropped", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-root-"));
    const global = mkdtempSync(join(tmpdir(), "mcp-global-"));
    writeFileSync(
      join(global, "mcp.json"),
      JSON.stringify({
        mcpServers: { a: { command: "g" }, b: { command: "g" } },
      }),
    );
    writeFileSync(
      join(root, ".viserc.json"),
      JSON.stringify({
        mcpServers: {
          a: { command: "p" },
          b: { command: "x", disabled: true },
          c: {},
        },
      }),
    );
    const { servers, problems } = loadMcpServers(root, global);
    expect(Object.keys(servers)).toEqual(["a"]);
    expect(servers["a"]?.command).toBe("p");
    expect(problems).toHaveLength(1);
  });
});

describe("mcp tools", () => {
  test("names are cleaned, capped and unique", () => {
    const taken = new Set<string>();
    expect(toolName("my server", "do.it", taken)).toBe("mcp__my_server__do_it");
    expect(toolName("my server", "do.it", taken)).toBe("mcp__my_server__do_it_2");
    expect(toolName("s", "x".repeat(100), taken)).toHaveLength(64);
  });

  test("results become text, errors are prefixed", () => {
    expect(
      formatResult({ content: [{ type: "text", text: "hi" }] }, undefined),
    ).toBe("hi");
    expect(
      formatResult(
        { isError: true, content: [{ type: "text", text: "no" }] },
        undefined,
      ),
    ).toBe("error: no");
    expect(formatResult({ structuredContent: { a: 1 } }, undefined)).toBe('{"a":1}');
    expect(formatResult({}, undefined)).toBe("(no output)");
  });
});

describe("mcp hub", () => {
  test("connects, lists, calls, reports errors and a crash", async () => {
    const hub = new McpHub(import.meta.dir, {
      servers: { fx: spec, bad: { command: "definitely-not-a-command", args: [], env: {} } },
      problems: [],
    });
    await hub.start();
    try {
      const names = hub.tools().map((t) => t.function.name);
      expect(names).toEqual([
        "mcp__fx__echo",
        "mcp__fx__fail",
        "mcp__fx__crash",
      ]);
      expect(hub.tools()[0]?.deferred).toBe(true);
      const run = hub.handlers();
      expect(await run["mcp__fx__echo"]!({ text: "yo" })).toBe("echo: yo");
      expect(await run["mcp__fx__fail"]!({})).toBe("error: boom");

      const status = hub.status();
      expect(status.find((s) => s.name === "bad")?.status.state).toBe("failed");
      expect(mcpNote(hub)).toContain("bad is unavailable");
      expect(formatMcpStatus(status, [])).toContain("fx  ready");

      expect(await run["mcp__fx__crash"]!({})).toStartWith("error:");
      const after = await run["mcp__fx__echo"]!({ text: "x" });
      expect(after).toStartWith("error: MCP server fx");
    } finally {
      await hub.close();
    }
  });
});
