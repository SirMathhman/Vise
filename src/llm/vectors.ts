// Semantic search: vector index over project files. Walks the working
// directory, chunks files into ~800-char blocks, embeds them via the
// llama.cpp server's /embeddings endpoint (through the LLM client, per
// invariant 2), and stores the results in a SQLite DB. Only re-embeds
// files whose mtime or size changed since the last run, so steady-state
// startup is a no-op.

import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { Config } from "../config.ts";
import { embeddings } from "./client.ts";

const DB_DIR = ".vise";
const DB_PATH = path.join(DB_DIR, "vectors.db");
const CHUNK_CHARS = 800;

// --- Database ---

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  const d = new Database(DB_PATH);
  d.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      path TEXT NOT NULL,
      chunk INTEGER NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      PRIMARY KEY (path, chunk)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db = d;
  return d;
}

// --- Chunking ---

function chunkFile(content: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + CHUNK_CHARS, content.length);
    // Prefer breaking on a newline
    if (end < content.length) {
      const nl = content.lastIndexOf("\n", end);
      if (nl > start) end = nl;
    }
    const chunk = content.slice(start, end);
    if (chunk.trim().length > 0) chunks.push(chunk);
    start = end;
    if (end === content.length) break;
  }
  return chunks;
}

// --- Embedding ---

// Embeds a list of texts in one request via the LLM client and returns
// their vectors in order. Used by both index construction and search.
async function embedAll(
  config: Config,
  texts: string[],
): Promise<Float32Array[]> {
  const res = await embeddings(config, config.embedModel, texts);
  const out: Float32Array[] = [];
  for (const item of res) {
    out.push(new Float32Array(item.embedding));
  }
  return out;
}

// --- Index construction ---

function relPath(fullPath: string): string {
  const rel = path.relative(process.cwd(), fullPath);
  return rel.length > 0 ? rel : ".";
}

function isBinary(buf: Uint8Array): boolean {
  for (let i = 0; i < Math.min(buf.length, 1024); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// Returns the set of files (as forward-slash relative paths from cwd) that
// are not .gitignored. Delegates to `git ls-files` — the same authority the
// user's .gitignore is parsed through — so ignored files are skipped
// exactly as git sees them. When git is unavailable or errors, falls back
// to a recursive walk that skips node_modules/.git/.vise.
function listNonIgnoredFiles(): Set<string> {
  try {
    const out = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const set = new Set<string>();
    for (const line of out.split("\n")) {
      const t = line.replace(/\\/g, "/").trim();
      if (t.length > 0) set.add(t);
    }
    return set;
  } catch {
    // No git (or not a repo): walk and skip the obvious noise dirs.
    const set = new Set<string>();
    const SKIP = new Set(["node_modules", ".git", DB_DIR]);
    const stack = ["."];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) continue;
      let entries: IterableIterator<string>;
      try {
        entries = new Bun.Glob(
          dir === "." ? "**/*" : `${dir.replace(/\\/g, "/")}/**/*`,
        ).scanSync();
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!statSync(entry).isFile()) continue;
        const rel = relPath(entry);
        const parts = rel.split("/");
        if (parts.some((p) => SKIP.has(p))) continue;
        set.add(rel);
      }
    }
    return set;
  }
}

// Walks the working directory, embedding only files whose mtime/size
// differs from what's stored. Respects .gitignore. Returns a summary
// suitable for printing at startup.
export type IndexSummary = {
  indexed: number;
  unchanged: number;
  pruned: number;
  skipped: number;
};

export async function ensureIndexed(config: Config): Promise<IndexSummary> {
  const d = getDb();

  const candidatePaths = listNonIgnoredFiles();
  const files: { path: string; mtime: number; size: number }[] = [];
  for (const rel of candidatePaths) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path.resolve(process.cwd(), rel));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    files.push({ path: rel, mtime: st.mtimeMs, size: st.size });
  }

  // Load existing index into a Map for O(1) lookup.
  const existing = new Map<
    string,
    { mtime: number; size: number; chunks: number }
  >();
  const rows = d
    .query<{ path: string; mtime: number; size: number; chunk: number }, []>(
      `SELECT path, mtime, size, chunk FROM chunks`,
    )
    .all();
  for (const row of rows) {
    const key = row.path;
    const prev = existing.get(key);
    if (prev) {
      prev.chunks = Math.max(prev.chunks, row.chunk + 1);
    } else {
      existing.set(key, {
        mtime: row.mtime,
        size: row.size,
        chunks: row.chunk + 1,
      });
    }
  }

  const toEmbed: { path: string; mtime: number; size: number }[] = [];
  let upToDate = 0;
  for (const f of files) {
    const prev = existing.get(f.path);
    if (prev && prev.mtime === f.mtime && prev.size === f.size) {
      upToDate++;
    } else {
      toEmbed.push(f);
    }
  }

  let embedded = 0;
  let failed = 0;

  for (const f of toEmbed) {
    let content: string;
    try {
      const buf = readFileSync(path.resolve(process.cwd(), f.path));
      if (isBinary(buf)) continue;
      content = buf.toString("utf-8");
    } catch {
      continue;
    }
    const chunks = chunkFile(content);
    if (chunks.length === 0) continue;
    try {
      const embeddings = await embedAll(config, chunks);
      d.run(`DELETE FROM chunks WHERE path = ?`, [f.path]);
      for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddings[i];
        if (!embedding) continue;
        const chunkContent = chunks[i];
        if (chunkContent === undefined) continue;
        d.run(
          `INSERT OR REPLACE INTO chunks (path, chunk, mtime, size, content, embedding) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            f.path,
            i,
            f.mtime,
            f.size,
            chunkContent,
            new Uint8Array(embedding.buffer),
          ],
        );
      }
      embedded++;
    } catch {
      failed++;
    }
  }

  // Prune files that no longer exist or are now gitignored.
  let pruned = 0;
  const currentPaths = new Set(files.map((f) => f.path));
  for (const key of existing.keys()) {
    if (!currentPaths.has(key)) {
      d.run(`DELETE FROM chunks WHERE path = ?`, [key]);
      pruned++;
    }
  }

  d.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('count', ?)`, [
    String(files.length),
  ]);

  return {
    indexed: embedded,
    unchanged: upToDate,
    pruned,
    skipped: failed,
  };
}

// --- Search ---

export type SearchResult = {
  path: string;
  chunk: number;
  content: string;
  score: number;
};

export async function semanticSearch(
  config: Config,
  query: string,
  k: number,
): Promise<SearchResult[]> {
  const d = getDb();

  const [queryEmbedding] = await embedAll(config, [query]);
  if (!queryEmbedding) return [];

  const rows = d
    .query<
      {
        path: string;
        chunk: number;
        content: string;
        embedding: Uint8Array;
      },
      []
    >(`SELECT path, chunk, content, embedding FROM chunks`)
    .all();

  const results: SearchResult[] = [];
  for (const row of rows) {
    const embedding = new Float32Array(row.embedding.buffer);
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    for (let i = 0; i < queryEmbedding.length; i++) {
      const q = queryEmbedding[i] ?? 0;
      const e = embedding[i] ?? 0;
      dot += q * e;
      aNorm += q * q;
      bNorm += e * e;
    }
    const score =
      aNorm > 0 && bNorm > 0 ? dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm)) : 0;
    results.push({
      path: row.path,
      chunk: row.chunk,
      content: row.content,
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, k);
}
