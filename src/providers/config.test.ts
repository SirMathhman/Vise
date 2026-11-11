import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServers } from "./config.ts";

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
