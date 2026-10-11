/**
 * Semantic search: file content is chunked, embedded, and stored in the
 * project's SQLite database. Search computes cosine similarity in JS over
 * the stored vectors.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import type { Result } from "../core/errors.ts";
import { openDb } from "../db/open.ts";
import { SESSION_MIGRATIONS } from "../db/session/session-schema.ts";

/** A single chunk of file content. */
export interface Chunk {
  /** 0-based line index of the chunk's first line. */
  start: number;
  /** 0-based line index of the chunk's last line (inclusive). */
  end: number;
  content: string;
}

/** A file's chunking result. */
export interface FileChunks {
  /** Path relative to the index root. */
  relativePath: string;
  chunks: Chunk[];
}

/** A semantic search hit. */
export interface SemanticHit {
  filePath: string;
  chunkIndex: number;
  content: string;
  score: number;
}

/** Directories and files to skip during the walk. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vise",
  "dist",
  "out",
]);

/** Maximum file size to index (bytes). */
export const EMBED_MAX_BYTES = 1_000_000;

/** Window size in lines. */
const CHUNK_LINES = 50;
/** Window size in characters (whichever limit hits first). */
const CHUNK_CHARS = 2000;
/** Lines of overlap between consecutive chunks. */
const CHUNK_OVERLAP = 10;

/**
 * Chunk a file's content into fixed-size windows.
 * Window = min(CHUNK_LINES, CHUNK_CHARS) lines. Overlap = CHUNK_OVERLAP lines.
 */
export function chunkFile(content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return [];
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < lines.length) {
    // Determine window end: at most CHUNK_LINES ahead, but no more than
    // CHUNK_CHARS total characters.
    let end = Math.min(i + CHUNK_LINES, lines.length);
    // Trim to char limit.
    let chars = 0;
    let charEnd = end;
    for (let j = i; j < end; j++) {
      chars += lines[j].length + 1;
      if (chars > CHUNK_CHARS) {
        charEnd = j;
        break;
      }
    }
    if (charEnd <= i) charEnd = i + 1;
    end = Math.min(end, charEnd);
    const content = lines.slice(i, end).join("\n");
    if (content.trim() !== "") {
      chunks.push({ start: i, end: end - 1, content });
    }
    // Advance by window minus overlap.
    i += Math.max(CHUNK_LINES - CHUNK_OVERLAP, 1);
  }
  return chunks;
}

/**
 * Walk a directory tree and yield file chunks for every indexable file.
 * Skips `node_modules`, `.git`, `.vise`, hidden directories, symlinks,
 * binary files, and files larger than `maxBytes`.
 */
export function* walkAndChunk(
  root: string,
  maxBytes: number = EMBED_MAX_BYTES,
): Generator<FileChunks> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.size > maxBytes) continue;
        if (stat.size === 0) continue;
        // Binary detection: NUL byte in the first 8 KB.
        let content: string;
        try {
          const buf = readFileSync(fullPath);
          if (buf.length > 8192) {
            const head = buf.subarray(0, 8192);
            if (head.includes(0)) continue;
          } else if (buf.includes(0)) {
            continue;
          }
          content = buf.toString("utf-8");
        } catch {
          continue;
        }
        const chunks = chunkFile(content);
        if (chunks.length === 0) continue;
        yield {
          relativePath: relative(root, fullPath).split(sep).join("/"),
          chunks,
        };
      }
    }
  }
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Store embeddings for one file: delete old chunks, insert new ones.
 * `embeddings` must have the same length as `chunks`.
 */
export function indexFile(
  db: Database,
  filePath: string,
  chunks: Chunk[],
  embeddings: number[][],
): void {
  db.transaction(() => {
    db.query("DELETE FROM file_embeddings WHERE file_path = ?").run(filePath);
    const insert = db.query(
      "INSERT INTO file_embeddings (file_path, chunk_index, content, embedding, dims, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (let i = 0; i < chunks.length; i++) {
      const f32 = new Float32Array(embeddings[i]);
      insert.run(filePath, i, chunks[i].content, f32.buffer, f32.length, now);
    }
  })();
}

/** Remove all embeddings for a file. */
export function deleteFile(db: Database, filePath: string): void {
  db.query("DELETE FROM file_embeddings WHERE file_path = ?").run(filePath);
}

/**
 * Search all stored embeddings by cosine similarity. Returns the top `limit`
 * hits sorted by score descending.
 */
export function searchEmbeddings(
  db: Database,
  queryEmbedding: number[],
  limit: number,
): SemanticHit[] {
  const rows = db
    .query(
      "SELECT file_path, chunk_index, content, embedding, dims FROM file_embeddings",
    )
    .all() as {
    file_path: string;
    chunk_index: number;
    content: string;
    embedding: Uint8Array;
    dims: number;
  }[];
  if (rows.length === 0) return [];

  const query = new Float32Array(queryEmbedding);
  const scored: { hit: SemanticHit; score: number }[] = [];
  for (const row of rows) {
    if (row.dims !== query.length) continue; // dimension mismatch: skip
    const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dims);
    const score = cosineSimilarity(query, stored);
    scored.push({
      hit: {
        filePath: row.file_path,
        chunkIndex: row.chunk_index,
        content: row.content,
        score,
      },
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.hit);
}

/** Remove all embeddings (for a full re-index). */
export function clearAll(db: Database): void {
  db.query("DELETE FROM file_embeddings").run();
}

/**
 * Bundles the database connection and embedding client for semantic search.
 * One per session root. Created by the edge; used by the command handler,
 * the model-facing tool, and the web API.
 */
export class SemanticIndex {
  private readonly db: Database;
  private readonly root: string;
  private readonly embed: (text: string) => Promise<Result<number[]>>;

  constructor(
    root: string,
    dataDir: string,
    embed: (text: string) => Promise<Result<number[]>>,
  ) {
    const result = openDb(join(dataDir, "vise.db"), SESSION_MIGRATIONS);
    if (!result.ok) throw new Error(result.error.cause);
    this.db = result.value;
    this.root = root;
    this.embed = embed;
  }

  /** Search indexed file content for semantic matches to `query`. */
  async search(query: string, limit = 5): Promise<Result<SemanticHit[]>> {
    const emb = await this.embed(query);
    if (!emb.ok) return emb;
    return { ok: true, value: searchEmbeddings(this.db, emb.value, limit) };
  }

  /** Incremental index: embed and store chunks for files not yet indexed or changed. */
  async index(signal?: AbortSignal): Promise<{ indexed: number; skipped: number; failed: number }> {
    return indexRoot(this.root, join(this.root, ".vise"), this.embed, signal);
  }

  /** Full re-index: clear the store then index everything. */
  async reindex(signal?: AbortSignal): Promise<{ indexed: number; skipped: number; failed: number }> {
    clearAll(this.db);
    return indexRoot(this.root, join(this.root, ".vise"), this.embed, signal);
  }

  /** Whether any embeddings are stored. */
  hasIndex(): boolean {
    const row = this.db.query("SELECT COUNT(*) as n FROM file_embeddings").get() as { n: number };
    return row.n > 0;
  }
}

/**
 * Index every file in `root`, embedding each chunk and storing it.
 * Skips files whose last index is newer than the file's mtime (incremental).
 * Returns counts.
 */
export async function indexRoot(
  root: string,
  dataDir: string,
  embed: (text: string) => Promise<Result<number[]>>,
  signal?: AbortSignal,
): Promise<{ indexed: number; skipped: number; failed: number }> {
  const result = openDb(join(dataDir, "vise.db"), SESSION_MIGRATIONS);
  if (!result.ok) throw new Error(result.error.cause);
  const db = result.value;

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  // Load existing file paths with their indexed_at for incremental checks.
  const existing = db
    .query("SELECT file_path, indexed_at FROM file_embeddings GROUP BY file_path")
    .all() as { file_path: string; indexed_at: string }[];
  const indexedTimes = new Map<string, number>();
  for (const row of existing) {
    indexedTimes.set(row.file_path, new Date(row.indexed_at).getTime());
  }

  for (const file of walkAndChunk(root)) {
    if (signal?.aborted) break;
    const fullPath = join(root, file.relativePath);
    // Incremental: skip if already indexed and file hasn't changed.
    const prevTime = indexedTimes.get(file.relativePath);
    if (prevTime !== undefined) {
      let mtime: number;
      try {
        mtime = statSync(fullPath).mtimeMs;
      } catch {
        continue;
      }
      if (mtime <= prevTime) {
        skipped++;
        continue;
      }
    }
    const embeddings: number[][] = [];
    let ok = true;
    for (const chunk of file.chunks) {
      if (signal?.aborted) { ok = false; break; }
      const res = await embed(chunk.content);
      if (!res.ok) {
        failed++;
        ok = false;
        break;
      }
      embeddings.push(res.value);
    }
    if (ok && embeddings.length === file.chunks.length) {
      indexFile(db, file.relativePath, file.chunks, embeddings);
      indexed++;
    }
  }
  return { indexed, skipped, failed };
}
