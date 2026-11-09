import { expect, test } from "bun:test";
import { toolNames } from "../../core/tools.ts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileFile, type ProfileDetail } from "../../core/notes.ts";
import { profileStore } from "./profile-store.ts";

const plan: ProfileDetail = {
  name: "plan",
  summary: "careful planning",
  tools: ["list_files"],
  hooks: [{ point: "sessionStart", command: "echo hi" }],
  text: "Plan before you act.",
};

// A working directory with one profile, written as the /note command would.
async function rootWithPlan(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vise-profiles-"));
  await mkdir(join(root, "notes", "profile"), { recursive: true });
  await writeFile(join(root, "notes", "profile", "plan.md"), profileFile(plan), "utf8");
  return root;
}

test("lists and reads a profile, and writes changes that read back the same", async () => {
  const store = profileStore(await rootWithPlan(), toolNames);
  expect(await store.list()).toEqual({
    ok: true,
    value: [{ name: "plan", summary: "careful planning" }],
  });
  expect(await store.read("plan")).toEqual({ ok: true, value: plan });
  const changed = { ...plan, summary: "quick", tools: undefined, text: "Be brief." };
  expect((await store.write(changed)).ok).toBe(true);
  expect(await store.read("plan")).toEqual({ ok: true, value: changed });
});

test("refuses a write for a profile that does not exist, a tool that does not exist, or a bad hook", async () => {
  const store = profileStore(await rootWithPlan(), toolNames);
  expect((await store.write({ ...plan, name: "other" })).ok).toBe(false);
  expect((await store.write({ ...plan, tools: ["no_such_tool"] })).ok).toBe(false);
  expect(
    (await store.write({ ...plan, hooks: [{ point: "sessionStart", command: "a\nb" }] })).ok,
  ).toBe(false);
  expect(await store.read("../plan")).toMatchObject({ ok: false });
});
