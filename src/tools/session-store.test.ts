import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionStore } from "./session-store.ts";

test("saves a session, loads it back, and lists the saved names", async () => {
  const store = sessionStore(await mkdtemp(join(tmpdir(), "vise-sessions-")));
  expect(await store.list()).toEqual({ ok: true, value: [] });
  expect(await store.save("work", "{}\n")).toEqual({ ok: true, value: undefined });
  expect(await store.load("work")).toEqual({ ok: true, value: "{}\n" });
  expect(await store.list()).toEqual({ ok: true, value: ["work"] });
  expect((await store.load("missing")).ok).toBe(false);
});
