import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolNames } from "../core/tools.ts";
import { runTool } from "./run-tool.ts";
import type { McpRegistry } from "./mcp/registry.ts";

test("refuses an edit outside the working directory before asking for approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-run-"));
  let asked = 0;
  const result = await runTool(root)(
    {
      id: "e1",
      name: "edit_file",
      arguments: '{"path":"../x.txt","previous":"a","replacement":"b"}',
    },
    async () => {
      asked += 1;
      return true;
    },
    toolNames,
  );
  expect(result.startsWith("error:")).toBe(true);
  expect(asked).toBe(0);
});

test("creates a note only after the user approves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-run-"));
  const call = {
    id: "n1",
    name: "create_note",
    arguments: '{"category":"work","name":"plan"}',
  };
  const declined = await runTool(root)(call, async () => false, toolNames);
  expect(declined).toBe("the user declined this change");
  expect(await Bun.file(join(root, "notes", "work", "plan.md")).exists()).toBe(
    false,
  );
  const approved = await runTool(root)(call, async () => true, toolNames);
  expect(approved).toBe(`created ${join("notes", "work", "plan.md")}`);
  expect(await Bun.file(join(root, "notes", "work", "plan.md")).exists()).toBe(
    true,
  );
});

test("refuses a call to a tool that is switched off, before asking for approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-run-"));
  let asked = 0;
  const offered = toolNames.filter((name) => name !== "create_note");
  const result = await runTool(root)(
    {
      id: "n2",
      name: "create_note",
      arguments: '{"category":"work","name":"plan"}',
    },
    async () => {
      asked += 1;
      return true;
    },
    offered,
  );
  expect(result).toBe("error: tool create_note is switched off");
  expect(asked).toBe(0);
  expect(await Bun.file(join(root, "notes", "work", "plan.md")).exists()).toBe(
    false,
  );
});

// A registry with one server tool that records its calls, so no process is started.
function echoRegistry(calls: string[]): McpRegistry {
  return {
    specs: () => [],
    problems: () => [],
    statuses: () => [],
    has: (name) => name === "fake__echo",
    call: async (name, argumentsText) => {
      calls.push(`${name} ${argumentsText}`);
      return "echoed";
    },
    stop: async () => {},
  };
}

test("a server tool is previewed and runs only after the user approves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-run-"));
  const calls: string[] = [];
  const call = { id: "m1", name: "fake__echo", arguments: '{"text":"hi"}' };
  const previews: string[] = [];
  const offered = [...toolNames, "fake__echo"];
  const declined = await runTool(root, echoRegistry(calls))(
    call,
    async (preview) => {
      previews.push(preview);
      return false;
    },
    offered,
  );
  expect(declined).toBe("the user declined this change");
  expect(calls).toEqual([]);
  expect(previews).toEqual(['call fake__echo\n+++ arguments\n{"text":"hi"}']);
  const approved = await runTool(root, echoRegistry(calls))(call, async () => true, offered);
  expect(approved).toBe("echoed");
  expect(calls).toEqual(['fake__echo {"text":"hi"}']);
});

test("a server tool switched off is refused before anyone is asked", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-run-"));
  const calls: string[] = [];
  let asked = 0;
  const result = await runTool(root, echoRegistry(calls))(
    { id: "m2", name: "fake__echo", arguments: "{}" },
    async () => {
      asked += 1;
      return true;
    },
    toolNames,
  );
  expect(result).toBe("error: tool fake__echo is switched off");
  expect(asked).toBe(0);
  expect(calls).toEqual([]);
});
