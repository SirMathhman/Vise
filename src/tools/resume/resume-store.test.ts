import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeStore } from "./resume-store.ts";

test("a saved conversation is loaded back for the same directory and not for another", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-resume-"));
  const store = resumeStore(folder, "C:/work/one");
  expect(await store.load()).toEqual({ ok: true, value: undefined });
  const saved = await store.save({
    history: [{ role: "user", content: "hello" }],
    compacted: false,
  });
  expect(saved.ok).toBe(true);
  const loaded = await store.load();
  expect(loaded.ok && loaded.value?.history).toEqual([
    { role: "user", content: "hello" },
  ]);
  const other = await resumeStore(folder, "C:/work/two").load();
  expect(other).toEqual({ ok: true, value: undefined });
});
