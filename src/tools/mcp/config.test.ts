import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpStore, readMcpConfig, saveMcpConfig } from "./config.ts";

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vise-mcp-cfg-"));
}

test("saved servers are written to the file and read back as they were", async () => {
  const root = await freshRoot();
  const servers = [{ name: "fake", command: "node", args: ["server.js", "--quiet"] }];
  expect(await saveMcpConfig(root, servers)).toEqual({ ok: true, value: undefined });
  expect(await readMcpConfig(root)).toEqual({ ok: true, value: servers });
  expect(await readFile(join(root, ".vise", "mcp.json"), "utf8")).toContain('"fake"');
});

test("a save with a bad name, an empty command, or a repeated name writes nothing", async () => {
  const root = await freshRoot();
  expect((await saveMcpConfig(root, [{ name: "bad__name", command: "x", args: [] }])).ok).toBe(false);
  expect((await saveMcpConfig(root, [{ name: "fake", command: "", args: [] }])).ok).toBe(false);
  const repeated = [
    { name: "fake", command: "node", args: [] },
    { name: "fake", command: "node", args: [] },
  ];
  expect((await saveMcpConfig(root, repeated)).ok).toBe(false);
  expect(await readMcpConfig(root)).toEqual({ ok: true, value: [] });
});

test("the store reports the servers that started at startup, and saves through the same checks", async () => {
  const root = await freshRoot();
  const running = [{ name: "fake", started: true, tools: ["fake__echo"], problems: [] }];
  const store = mcpStore(root, running);
  expect(store.running()).toEqual(running);
  expect((await store.save([{ name: "fake", command: "node", args: [] }])).ok).toBe(true);
  expect(await store.config()).toEqual({
    ok: true,
    value: [{ name: "fake", command: "node", args: [] }],
  });
});
