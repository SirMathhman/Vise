import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfiguredProvider, providersStore, readServers, saveServers } from "./config.ts";

test("the providers in .vise/providers.json are read; a missing file lists none; a bad entry is refused", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-providers-"));
  expect(await readServers(folder)).toEqual({ ok: true, value: [] });
  await mkdir(join(folder, ".vise"));
  const file = join(folder, ".vise", "providers.json");
  const both: ConfiguredProvider[] = [
    { kind: "openrouter", name: "work", apiKey: "k1" },
    { kind: "llama.cpp", name: "local", url: "http://127.0.0.1:9931", apiKey: "k2" },
  ];
  await writeFile(file, JSON.stringify(both));
  expect(await readServers(folder)).toEqual({ ok: true, value: both });
  await writeFile(file, JSON.stringify([{ kind: "llama.cpp", name: "a:b", url: "http://x", apiKey: "k" }]));
  expect((await readServers(folder)).ok).toBe(false);
  await writeFile(file, JSON.stringify([{ name: "a", apiKey: "k" }]));
  expect((await readServers(folder)).ok).toBe(false);
  await writeFile(file, JSON.stringify([{ kind: "openrouter", name: "a", apiKey: "k" }, { kind: "openrouter", name: "a", apiKey: "k" }]));
  expect((await readServers(folder)).ok).toBe(false);
});

test("saving keeps a provider's key when its key is left blank, refuses a new provider without one, and never names a key", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-providers-save-"));
  expect(
    await saveServers(folder, [{ kind: "llama.cpp", name: "local", url: "http://127.0.0.1:9931", apiKey: "first" }]),
  ).toEqual({ ok: true, value: undefined });
  expect(
    await saveServers(folder, [{ kind: "llama.cpp", name: "local", url: "http://127.0.0.1:9932", apiKey: "" }]),
  ).toEqual({ ok: true, value: undefined });
  expect(await readServers(folder)).toEqual({
    ok: true,
    value: [{ kind: "llama.cpp", name: "local", url: "http://127.0.0.1:9932", apiKey: "first" }],
  });
  const noKey = await saveServers(folder, [{ kind: "openrouter", name: "new", url: "", apiKey: "" }]);
  expect(noKey.ok).toBe(false);
  if (!noKey.ok) expect(noKey.error.message).not.toContain("first");
  const duplicate = await saveServers(folder, [
    { kind: "openrouter", name: "a", url: "", apiKey: "k" },
    { kind: "openrouter", name: "a", url: "", apiKey: "k" },
  ]);
  expect(duplicate.ok).toBe(false);
  expect(await providersStore(folder).list()).toEqual({
    ok: true,
    value: [{ kind: "llama.cpp", name: "local", url: "http://127.0.0.1:9932", keySaved: true }],
  });
});
