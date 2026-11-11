import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providersStore, readServers, saveServers } from "./config.ts";

test("the servers in .vise/providers.json are read; a missing file lists none; a bad entry is refused", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-providers-"));
  expect(await readServers(folder)).toEqual({ ok: true, value: [] });
  await mkdir(join(folder, ".vise"));
  const file = join(folder, ".vise", "providers.json");
  await writeFile(file, JSON.stringify([{ name: "local", url: "http://127.0.0.1:9931", apiKey: "k" }]));
  expect(await readServers(folder)).toEqual({
    ok: true,
    value: [{ name: "local", url: "http://127.0.0.1:9931", apiKey: "k" }],
  });
  await writeFile(file, JSON.stringify([{ name: "a:b", url: "http://x", apiKey: "k" }]));
  expect((await readServers(folder)).ok).toBe(false);
  await writeFile(file, JSON.stringify([{ name: "a", url: "http://x", apiKey: "k" }, { name: "a", url: "http://y", apiKey: "k" }]));
  expect((await readServers(folder)).ok).toBe(false);
});

test("saving keeps a server's key when its key is left blank, refuses a new server without one, and never names a key", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-providers-save-"));
  expect(await saveServers(folder, [{ name: "local", url: "http://127.0.0.1:9931", apiKey: "first" }])).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await saveServers(folder, [{ name: "local", url: "http://127.0.0.1:9932", apiKey: "" }])).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await readServers(folder)).toEqual({
    ok: true,
    value: [{ name: "local", url: "http://127.0.0.1:9932", apiKey: "first" }],
  });
  const noKey = await saveServers(folder, [{ name: "new", url: "http://x", apiKey: "" }]);
  expect(noKey.ok).toBe(false);
  if (!noKey.ok) expect(noKey.error.message).not.toContain("first");
  expect((await saveServers(folder, [{ name: "a", url: "http://x", apiKey: "k" }, { name: "a", url: "http://y", apiKey: "k" }])).ok).toBe(false);
  const listed = await providersStore(folder).list();
  expect(listed).toEqual({ ok: true, value: [{ name: "local", url: "http://127.0.0.1:9932", keySaved: true }] });
});
