import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConfiguredProvider,
  effectiveProviders,
  providersStore,
  readScopedServers,
  readServers,
  saveScopedServers,
  saveServers,
} from "./config.ts";

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

test("a project provider replaces a home provider of the same name, and a save writes each file with its own entries", async () => {
  const local = await mkdtemp(join(tmpdir(), "vise-providers-local-"));
  const home = await mkdtemp(join(tmpdir(), "vise-providers-home-"));
  const homeLine = { kind: "llama.cpp" as const, name: "shared", url: "http://home:1", apiKey: "home-key", scope: "global" as const };
  expect((await saveScopedServers(local, home, [homeLine])).ok).toBe(true);
  const localLine = { kind: "llama.cpp" as const, name: "shared", url: "http://project:2", apiKey: "project-key", scope: "local" as const };
  expect((await saveScopedServers(local, home, [localLine])).ok).toBe(true);
  const read = await readScopedServers(local, home);
  expect(read.ok && read.value.map((entry) => entry.scope)).toEqual(["local"]);
  // A save writes each file with the entries of its scope, so the home entry left out above was removed from the home
  // file. Sending both again puts it back.
  expect((await saveScopedServers(local, home, [localLine, homeLine])).ok).toBe(true);
  const both = await readScopedServers(local, home);
  const running: ConfiguredProvider[] = effectiveProviders(both.ok ? both.value : []);
  expect(running.map((entry) => [entry.scope, entry.name])).toEqual([["local", "shared"]]);
  expect(await providersStore(home).list()).toEqual({
    ok: true,
    value: [{ kind: "llama.cpp", name: "shared", url: "http://home:1", keySaved: true }],
  });
});
