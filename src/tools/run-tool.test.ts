import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  );
  expect(result.startsWith("error:")).toBe(true);
  expect(asked).toBe(0);
});

test("creates a note only after the user approves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-run-"));
  const call = { id: "n1", name: "create_note", arguments: '{"category":"work","name":"plan"}' };
  const declined = await runTool(root)(call, async () => false);
  expect(declined).toBe("the user declined this change");
  expect(await Bun.file(join(root, "notes", "work", "plan.md")).exists()).toBe(false);
  const approved = await runTool(root)(call, async () => true);
  expect(approved).toBe(`created ${join("notes", "work", "plan.md")}`);
  expect(await Bun.file(join(root, "notes", "work", "plan.md")).exists()).toBe(true);
});
