import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ok } from "../../core/messages.ts";
import { startMcpServers, type McpRegistry } from "./registry.ts";

// A stand-in MCP server, written to a file and run with Bun. It answers the requests Vise makes:
// initialize, tools/list (two pages), and tools/call (echoing its arguments).
const FAKE_SERVER = `
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.id === undefined) continue;
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    if (message.method === "tools/list") {
      const page = message.params?.cursor === "next"
        ? [{ name: "second", description: "on page two", inputSchema: { type: "object" } }]
        : [{ name: "echo", description: "echoes its arguments", inputSchema: { type: "object", properties: { text: { type: "string" } } } }, { name: "fail", inputSchema: {} }, { name: "bad name!", inputSchema: {} }];
      send({ jsonrpc: "2.0", id: message.id, result: { tools: page, nextCursor: message.params?.cursor ? undefined : "next" } });
    }
    if (message.method === "tools/call") {
      if (message.params.name === "fail") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "went wrong" }], isError: true } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }, { type: "image" }] } });
      }
    }
  }
});
`;

let root: string;
let registry: McpRegistry | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vise-mcp-"));
  await mkdir(join(root, ".vise"));
  await writeFile(join(root, "fake-server.js"), FAKE_SERVER);
});

afterEach(async () => {
  await registry?.stop();
  registry = undefined;
  await rm(root, { recursive: true, force: true });
});

async function configure(servers: object): Promise<McpRegistry> {
  await writeFile(join(root, ".vise", "mcp.json"), JSON.stringify({ servers }));
  const started = await startMcpServers(root);
  expect(started.ok).toBe(true);
  registry = (started as Ok<McpRegistry>).value;
  return registry;
}

const fake = { fake: { command: process.execPath, args: ["fake-server.js"] } };

test("a server's tools are listed across pages, named by server, and a bad name is left out", async () => {
  const servers = await configure(fake);
  expect(servers.specs().map((spec) => spec.function.name)).toEqual([
    "fake__echo",
    "fake__fail",
    "fake__second",
  ]);
  expect(servers.problems()).toEqual(["fake: tool bad name! is left out: its name is not usable"]);
  expect(servers.has("fake__echo")).toBe(true);
  expect(servers.has("list_files")).toBe(false);
});

test("a call sends the arguments and returns the text, naming other content", async () => {
  const servers = await configure(fake);
  expect(await servers.call("fake__echo", '{"text":"hi"}')).toBe('{"text":"hi"}\n[image content]');
});

test("a result the server marks as an error is returned as an error", async () => {
  const servers = await configure({ fake: { command: process.execPath, args: ["fake-server.js"] } });
  expect(await servers.call("fake__fail", "{}")).toBe("error: went wrong");
});

test("arguments that are not a JSON object are refused before the server sees them", async () => {
  const servers = await configure(fake);
  expect(await servers.call("fake__echo", "[1]")).toBe("invalid arguments: expected a JSON object");
});

test("a server that cannot start is left out with a problem, and the others still load", async () => {
  const servers = await configure({
    missing: { command: "vise-no-such-program", args: [] },
    fake: { command: process.execPath, args: ["fake-server.js"] },
  });
  expect(servers.specs().map((spec) => spec.function.name)).toEqual([
    "fake__echo",
    "fake__fail",
    "fake__second",
  ]);
  expect(servers.problems()[0]?.startsWith("missing: ")).toBe(true);
});

test("a config file with a bad server name is an error for the whole start", async () => {
  await writeFile(join(root, ".vise", "mcp.json"), JSON.stringify({ servers: { "bad__name": { command: "x" } } }));
  const started = await startMcpServers(root);
  expect(started.ok).toBe(false);
});
