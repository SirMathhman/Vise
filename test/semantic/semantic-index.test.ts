import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "@vise/core";
import { closeAllDbs } from "../../packages/backend/src/db/open.ts";
import { SemanticIndex } from "../../packages/backend/src/stores/semantic/semantic-index.ts";

afterAll(() => closeAllDbs());

const VOCABULARY = ["login", "password", "token", "database", "query", "sql", "button", "style", "render"];

/** A stand-in embedder: a text becomes how often each vocabulary word occurs in it. */
function bagOfWords(texts: string[]): Result<number[][]> {
  return {
    ok: true,
    value: texts.map((text) => {
      const words = text.toLowerCase().split(/[^a-z]+/);
      return VOCABULARY.map((w) => words.filter((x) => x === w).length);
    }),
  };
}

function project(): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "vise-sem-root-"));
  const dataDir = mkdtempSync(join(tmpdir(), "vise-sem-data-"));
  const put = (path: string, text: string): void => {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...path.split("/")), text);
  };
  put("src/auth.ts", "// login with a password\nexport function login(password: string, token: string) {}\n");
  put("src/db.ts", "// database query\nexport const sql = 'select * from a';\nexport function query() {}\n");
  put("src/ui.css", "button { style: render; }\n");
  put(".env", "TOKEN=login password token\n");
  return { root, dataDir };
}

function indexOf(
  root: string,
  dataDir: string,
  extra: { embed?: (texts: string[]) => Promise<Result<number[][]>>; model?: () => string } = {},
): SemanticIndex {
  return new SemanticIndex({
    root,
    dataDir,
    embed: extra.embed ?? (async (texts) => bagOfWords(texts)),
    model: extra.model ?? (() => "bow-1"),
  });
}

test("indexing makes files findable by meaning, with 1-based line ranges, and never indexes secrets", async () => {
  const { root, dataDir } = project();
  const index = indexOf(root, dataDir);
  expect(index.status().state).toBe("empty");
  const run = await index.update();
  expect(run.ok && run.value).toEqual({ indexed: 3, skipped: 0, removed: 0, failed: 0 });
  expect(index.status()).toMatchObject({ state: "ready", files: 3, model: "bow-1" });

  const hits = await index.search("how do I log in with a password", 3);
  expect(hits.ok).toBe(true);
  if (!hits.ok) return;
  expect(hits.value[0]).toMatchObject({ path: "src/auth.ts", startLine: 1, endLine: 2 });
  expect(hits.value.map((h) => h.path)).not.toContain(".env");
  expect(hits.value[0]!.score).toBeGreaterThan(hits.value.at(-1)!.score);
});

test("a second update does nothing; a changed file is re-embedded; a deleted file is forgotten", async () => {
  const { root, dataDir } = project();
  const index = indexOf(root, dataDir);
  await index.update();

  const again = await index.update();
  expect(again.ok && again.value).toMatchObject({ indexed: 0, skipped: 3, removed: 0 });

  const file = join(root, "src", "ui.css");
  writeFileSync(file, "button { login: password; }\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  rmSync(join(root, "src", "db.ts"));
  const changed = await index.update();
  expect(changed.ok && changed.value).toMatchObject({ indexed: 1, skipped: 1, removed: 1 });

  const hits = await index.search("sql database query", 5);
  expect(hits.ok && hits.value.map((h) => h.path)).not.toContain("src/db.ts");
});

test("concurrent updates are one run", async () => {
  const { root, dataDir } = project();
  let calls = 0;
  const index = indexOf(root, dataDir, {
    embed: async (texts) => {
      calls += texts.length;
      return bagOfWords(texts);
    },
  });
  const [a, b] = await Promise.all([index.update(), index.update()]);
  expect(a).toBe(b);
  expect(calls).toBe(3);
});

test("a changed embedding model leaves the old vectors unsearched until a rebuild", async () => {
  const { root, dataDir } = project();
  let model = "bow-1";
  const index = indexOf(root, dataDir, { model: () => model });
  await index.update();
  model = "bow-2";
  expect(index.status()).toMatchObject({ state: "empty" });
  expect(index.status().reason).toContain("another embedding model");
  const none = await index.search("login", 3);
  expect(none.ok && none.value).toEqual([]);
  await index.update({ rebuild: true });
  expect(index.status()).toMatchObject({ state: "ready", model: "bow-2", files: 3 });
});

test("an embedder that refuses is a status with what to do, not a throw", async () => {
  const { root, dataDir } = project();
  const index = indexOf(root, dataDir, {
    embed: async () => ({ ok: false, error: { kind: "http", status: 501, body: '{"error":{"message":"embeddings not supported"}}' } }),
  });
  const run = await index.update();
  expect(run.ok).toBe(false);
  const status = index.status();
  expect(status.state).toBe("unavailable");
  expect(status.reason).toContain("VISE_EMBEDDING_MODEL");
  expect(status.reason).toContain("embeddings not supported");
});

test("listeners hear progress and the end of a run", async () => {
  const { root, dataDir } = project();
  const index = indexOf(root, dataDir);
  let heard = 0;
  const off = index.onChange(() => (heard += 1));
  await index.update();
  off();
  expect(heard).toBeGreaterThanOrEqual(4); // start, three files, end
});
