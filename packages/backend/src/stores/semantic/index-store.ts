import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Result } from "@vise/core";
import { openDb, tryDb } from "../../db/open.ts";
import { SESSION_MIGRATIONS } from "../../db/session/session-schema.ts";
import type { Chunk } from "./chunk.ts";
import { decodeVector, encodeVector } from "./vectors.ts";

/** A file as the index holds it (one entry per file, whatever its chunk count). */
export interface StoredFile {
  path: string;
  mtimeMs: number;
  model: string;
}

/** One embedded chunk, read back for a search. */
export interface StoredChunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  vector: Float32Array;
}

/** What the table holds for a model. */
export interface IndexTotals {
  files: number;
  chunks: number;
  /** Chunks embedded by some other model: kept until a rebuild, never searched. */
  otherModelChunks: number;
}

/**
 * The `file_embeddings` table of a project's `vise.db`: the only code that
 * reads or writes it. Every method answers a `Result` (a database failure is a
 * `storage` error, never a throw). Reads for a search are cached in memory
 * until the next write.
 */
export class IndexStore {
  private cache: { model: string; chunks: StoredChunk[] } | undefined;

  private constructor(
    private readonly db: Database,
    private readonly path: string,
  ) {}

  /** The index of the project whose Vise data lives in `dataDir` (the shared connection of its `vise.db`). */
  static open(dataDir: string): Result<IndexStore> {
    const path = join(dataDir, "vise.db");
    const opened = openDb(path, SESSION_MIGRATIONS);
    return opened.ok ? { ok: true, value: new IndexStore(opened.value, path) } : opened;
  }

  private run<T>(op: string, fn: () => T): Result<T> {
    return tryDb(op, this.path, fn);
  }

  /** Every indexed file with when it was read and by which model. */
  files(): Result<StoredFile[]> {
    return this.run("read the semantic index", () =>
      (
        this.db
          .query("SELECT file_path AS path, MAX(mtime_ms) AS mtimeMs, model FROM file_embeddings GROUP BY file_path")
          .all() as StoredFile[]
      ).map((f) => ({ path: f.path, mtimeMs: f.mtimeMs, model: f.model })),
    );
  }

  /** Replace all of a file's chunks with `chunks` and their `vectors`. */
  replaceFile(
    path: string,
    chunks: Chunk[],
    vectors: ArrayLike<number>[],
    model: string,
    mtimeMs: number,
  ): Result<void> {
    return this.run("write the semantic index", () => {
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db.query("DELETE FROM file_embeddings WHERE file_path = ?").run(path);
        const insert = this.db.query(
          `INSERT INTO file_embeddings
             (file_path, chunk_index, start_line, end_line, content, embedding, dims, model, mtime_ms, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        chunks.forEach((chunk, i) => {
          const vector = vectors[i] ?? [];
          insert.run(path, i, chunk.start, chunk.end, chunk.content, encodeVector(vector), vector.length, model, mtimeMs, now);
        });
      })();
      this.cache = undefined;
    });
  }

  /** Forget these files. */
  removeFiles(paths: string[]): Result<void> {
    return this.run("write the semantic index", () => {
      this.db.transaction(() => {
        const remove = this.db.query("DELETE FROM file_embeddings WHERE file_path = ?");
        for (const path of paths) remove.run(path);
      })();
      this.cache = undefined;
    });
  }

  /** Forget everything. */
  clear(): Result<void> {
    return this.run("write the semantic index", () => {
      this.db.query("DELETE FROM file_embeddings").run();
      this.cache = undefined;
    });
  }

  totals(model: string): Result<IndexTotals> {
    return this.run("read the semantic index", () => {
      const mine = this.db
        .query("SELECT COUNT(DISTINCT file_path) AS files, COUNT(*) AS chunks FROM file_embeddings WHERE model = ?")
        .get(model) as { files: number; chunks: number };
      const other = this.db
        .query("SELECT COUNT(*) AS chunks FROM file_embeddings WHERE model != ?")
        .get(model) as { chunks: number };
      return { files: mine.files, chunks: mine.chunks, otherModelChunks: other.chunks };
    });
  }

  /** Every chunk `model` embedded, with its vector decoded. */
  chunks(model: string): Result<StoredChunk[]> {
    if (this.cache?.model === model) return { ok: true, value: this.cache.chunks };
    return this.run("read the semantic index", () => {
      const rows = this.db
        .query(
          "SELECT file_path, start_line, end_line, content, embedding, dims FROM file_embeddings WHERE model = ?",
        )
        .all(model) as {
        file_path: string;
        start_line: number;
        end_line: number;
        content: string;
        embedding: Uint8Array;
        dims: number;
      }[];
      const chunks = rows.map((row) => ({
        path: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
        vector: decodeVector(row.embedding, row.dims),
      }));
      this.cache = { model, chunks };
      return chunks;
    });
  }
}
