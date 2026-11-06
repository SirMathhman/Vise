import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolNames } from "../core/tools.ts";
import { runTool } from "./run-tool.ts";

test("refuses an edit outside the working directory before asking for approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-run-"));
  let asked = 0;
  const result = await runTool(root)(
    { id: "e1", name: "edit_file", arguments: '{"path":"../x.txt","previous":"a","replacement":"b"}' },
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
  const call = { id: "n1", name: "create_note", arguments: '{"category":"work","name":"plan"}' };
  const declined = await runTool(root)(call, async () => false, toolNames);
  expect(declined).toBe("the user declined this change");
  expect(await Bun.file(join(root, "notes", "work", "plan.md")).exists()).toBe(false);
  const approved = await runTool(root)(call, async () => true, toolNames);
  expect(approved).toBe(`created ${join("notes", "work", "plan.md")}`);
  expect(await Bun.file(join(root, "notes", "work", "plan.md")).exists()).toBe(true);
});

test("refuses a call to a tool that is switched off, before asking for approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-run-"));
  let asked = 0;
  const offered = toolNames.filter((name) => name !== "create_note");
  const result = await runTool(root)(
    { id: "n2", name: "create_note", arguments: '{"category":"work","name":"plan"}' },
    async () => {
      asked += 1;
      return true;
    },
    offered,
  );
  expect(result).toBe("error: tool create_note is switched off");
  expect(asked).toBe(0);
  expect(await Bun.file(join(root, "notes", "work", "plan.md")).exists()).toBe(false);
});
