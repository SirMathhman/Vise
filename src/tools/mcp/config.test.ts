import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveServers, mcpStore, readMcpConfig, readScopedMcp, saveMcpConfig, saveScopedMcp } from "./config.ts";

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vise-mcp-cfg-"));
}

// Writes a servers file as text, to check what the reader does with it.
async function writeFileText(root: string, text: string): Promise<void> {
  await mkdir(join(root, ".vise"), { recursive: true });
  await writeFile(join(root, ".vise", "mcp.json"), text, "utf8");
}

test("saved servers are written to the file and read back as they were", async () => {
  const root = await freshRoot();
  const servers = [{ kind: "stdio" as const, name: "fake", command: "node", args: ["server.js", "--quiet"] }];
  expect(await saveMcpConfig(root, servers)).toEqual({ ok: true, value: undefined });
  expect(await readMcpConfig(root)).toEqual({ ok: true, value: servers });
  expect(await readFile(join(root, ".vise", "mcp.json"), "utf8")).toContain('"fake"');
});

test("a save with a bad name, an empty command, or a repeated name writes nothing", async () => {
  const root = await freshRoot();
  expect((await saveMcpConfig(root, [{ kind: "stdio", name: "bad__name", command: "x", args: [] }])).ok).toBe(false);
  expect((await saveMcpConfig(root, [{ kind: "stdio", name: "fake", command: "", args: [] }])).ok).toBe(false);
  const repeated = [
    { kind: "stdio" as const, name: "fake", command: "node", args: [] },
    { kind: "stdio" as const, name: "fake", command: "node", args: [] },
  ];
  expect((await saveMcpConfig(root, repeated)).ok).toBe(false);
  expect(await readMcpConfig(root)).toEqual({ ok: true, value: [] });
});

test("the store reports the servers that started at startup, and saves through the same checks", async () => {
  const root = await freshRoot();
  const running = [{ name: "fake", started: true, tools: ["fake__echo"], problems: [] }];
  const store = mcpStore(root, running);
  expect(store.running()).toEqual(running);
  expect((await store.save([{ kind: "stdio", name: "fake", command: "node", args: [] }])).ok).toBe(true);
  expect(await store.config()).toEqual({
    ok: true,
    value: [{ kind: "stdio", name: "fake", command: "node", args: [] }],
  });
});

test("an HTTP server is saved with its url and headers, and read back the same way", async () => {
  const root = await freshRoot();
  const servers = [
    { kind: "http" as const, name: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer t" } },
  ];
  expect((await saveMcpConfig(root, servers)).ok).toBe(true);
  expect(await readMcpConfig(root)).toEqual({ ok: true, value: servers });
});

test("an entry with both a command and a url, a url that is not http, or a bad header is refused", async () => {
  const root = await freshRoot();
  await writeFileText(root, JSON.stringify({ servers: { both: { command: "x", url: "https://a.test" } } }));
  expect((await readMcpConfig(root)).ok).toBe(false);
  await writeFileText(root, JSON.stringify({ servers: { ftp: { url: "ftp://a.test" } } }));
  expect((await readMcpConfig(root)).ok).toBe(false);
  await writeFileText(root, JSON.stringify({ servers: { bad: { url: "https://a.test", headers: { "bad name": "x" } } } }));
  expect((await readMcpConfig(root)).ok).toBe(false);
});

test("a header left blank keeps the value stored for it, and a new header with no value is refused", async () => {
  const root = await freshRoot();
  const first = [{ kind: "http" as const, name: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer t" } }];
  expect((await saveMcpConfig(root, first)).ok).toBe(true);
  const blank = [{ kind: "http" as const, name: "remote", url: "https://example.test/mcp", headers: { Authorization: "" } }];
  expect((await saveMcpConfig(root, blank)).ok).toBe(true);
  expect(await readMcpConfig(root)).toEqual({ ok: true, value: first });
  const added = [{ kind: "http" as const, name: "remote", url: "https://example.test/mcp", headers: { "X-New": "" } }];
  expect((await saveMcpConfig(root, added)).ok).toBe(false);
});

test("a project server replaces a home server of the same name, and a save writes each file with its own servers", async () => {
  const local = await freshRoot();
  const home = await freshRoot();
  const homeServer = { kind: "stdio" as const, name: "docs", command: "home-docs", args: [], scope: "global" as const };
  const localServer = { kind: "stdio" as const, name: "docs", command: "project-docs", args: [], scope: "local" as const };
  expect((await saveScopedMcp(local, home, [homeServer, localServer])).ok).toBe(true);
  const both = await readScopedMcp(local, home);
  expect(both.ok && both.value.map((server) => server.scope)).toEqual(["local", "global"]);
  const running = effectiveServers(both.ok ? both.value : []);
  expect(running.map((server) => (server.kind === "stdio" ? server.command : ""))).toEqual(["project-docs"]);
  expect((await readMcpConfig(home)).ok && (await readMcpConfig(home))).toEqual({ ok: true, value: [{ kind: "stdio", name: "docs", command: "home-docs", args: [] }] });
});
