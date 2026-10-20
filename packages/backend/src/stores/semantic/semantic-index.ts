import type { AuditSink } from "@vise/core";
import type { Result, ViseError } from "@vise/core";
import { formatError } from "../../output/format.ts";
import type {
  SemanticHit,
  SemanticIndexPort,
  SemanticStatus,
  SemanticUpdateStats,
} from "../../repl/ports.ts";
import { chunkFile } from "./chunk.ts";
import { IndexStore } from "./index-store.ts";
import { cosine, norm } from "./vectors.ts";
import { listIndexable, readText } from "./walk.ts";

/** How a semantic index embeds text and which model it does so with (read live: the setting can change). */
export interface SemanticIndexOptions {
  /** The folder whose files are indexed. */
  root: string;
  /** Where the project's `vise.db` lives. */
  dataDir: string;
  embed(texts: string[]): Promise<Result<number[][]>>;
  model(): string;
  audit?: AuditSink;
  /** Chunks per embedding request. */
  batchSize?: number;
}

const BATCH = 16;
/** Lines of a passage shown as its snippet. */
const SNIPPET_LINES = 6;
const SNIPPET_CHARS = 400;

/** Indexes shared by every connection to a project, keyed by its data directory. */
const shared = new Map<string, SemanticIndex>();

/** The project's index: the one already made for this data directory, or a new one. */
export function semanticIndexFor(options: SemanticIndexOptions): SemanticIndex {
  const existing = shared.get(options.dataDir);
  if (existing) return existing;
  const made = new SemanticIndex(options);
  shared.set(options.dataDir, made);
  return made;
}

/** Forget the shared indexes (tests). */
export function forgetSemanticIndexes(): void {
  shared.clear();
}

/**
 * Files of one project made searchable by meaning: chunks embedded through
 * `embed` and compared by cosine similarity in memory (a project is hundreds
 * to a few thousand chunks). Updating is incremental by modification time and
 * single-flight; a failing embedder is a status, not an exception.
 */
export class SemanticIndex implements SemanticIndexPort {
  private running: Promise<Result<SemanticUpdateStats>> | undefined;
  private progress: { done: number; total: number } | undefined;
  private failure: string | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: SemanticIndexOptions) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private store(): Result<IndexStore> {
    return IndexStore.open(this.options.dataDir);
  }

  status(): SemanticStatus {
    const model = this.options.model();
    const base = { files: 0, chunks: 0, model };
    if (this.running && this.progress) {
      return { ...base, ...this.totalsOf(model), state: "indexing", ...this.progress };
    }
    if (this.failure !== undefined)
      return { ...base, ...this.totalsOf(model), state: "unavailable", reason: this.failure };
    const totals = this.totalsOf(model);
    if (totals.chunks > 0) return { ...base, ...totals, state: "ready" };
    return {
      ...base,
      state: "empty",
      ...(totals.stale > 0
        ? { reason: "the index was built with another embedding model; run /embed rebuild" }
        : {}),
    };
  }

  private totalsOf(model: string): { files: number; chunks: number; stale: number } {
    const opened = this.store();
    if (!opened.ok) return { files: 0, chunks: 0, stale: 0 };
    const totals = opened.value.totals(model);
    return totals.ok
      ? {
          files: totals.value.files,
          chunks: totals.value.chunks,
          stale: totals.value.otherModelChunks,
        }
      : { files: 0, chunks: 0, stale: 0 };
  }

  async search(query: string, limit: number): Promise<Result<SemanticHit[]>> {
    const opened = this.store();
    if (!opened.ok) return opened;
    const model = this.options.model();
    const chunks = opened.value.chunks(model);
    if (!chunks.ok) return chunks;
    if (chunks.value.length === 0) return { ok: true, value: [] };
    const embedded = await this.options.embed([query]);
    if (!embedded.ok) return { ok: false, error: this.explain(embedded.error, model) };
    const queryVector = embedded.value[0] ?? [];
    const queryNorm = norm(queryVector);
    const scored = chunks.value
      .filter((c) => c.vector.length === queryVector.length)
      .map((c) => ({ score: cosine(queryVector, c.vector, queryNorm), chunk: c }))
      .sort((x, y) => y.score - x.score);
    const hits: SemanticHit[] = [];
    for (const { score, chunk } of scored) {
      if (hits.length >= limit) break;
      const start = chunk.startLine + 1;
      const end = chunk.endLine + 1;
      // Windows overlap: of two overlapping hits in a file the better one is enough.
      if (hits.some((h) => h.path === chunk.path && start <= h.endLine && end >= h.startLine))
        continue;
      hits.push({
        path: chunk.path,
        startLine: start,
        endLine: end,
        score,
        snippet: chunk.content
          .split("\n")
          .slice(0, SNIPPET_LINES)
          .join("\n")
          .slice(0, SNIPPET_CHARS),
      });
    }
    this.options.audit?.record({
      kind: "event",
      name: "semantic_search",
      payload: { query, hits: hits.length, top: hits[0]?.score },
    });
    return { ok: true, value: hits };
  }

  update(options: { rebuild?: boolean } = {}): Promise<Result<SemanticUpdateStats>> {
    if (this.running) return this.running;
    const run = this.run(options.rebuild === true).finally(() => {
      this.running = undefined;
      this.progress = undefined;
      this.notify();
    });
    this.running = run;
    return run;
  }

  /** The error as one sentence that says what to do about an embedder that did not work. */
  private explain(error: ViseError, model: string): ViseError {
    const why = formatError(error).replace(/^vise: /, "");
    // A server that cannot embed at all (Strata): no model setting would help, so the reason is the whole answer.
    if (error.kind === "malformed" && error.body.includes("no embeddings endpoint")) {
      return { kind: "malformed", body: why };
    }
    return {
      kind: "malformed",
      body: `the embedding model "${model}" could not embed (${why}). Set VISE_EMBEDDING_MODEL to a model the local server can embed with.`,
    };
  }

  private async run(rebuild: boolean): Promise<Result<SemanticUpdateStats>> {
    const started = Date.now();
    const opened = this.store();
    if (!opened.ok) {
      this.failure = formatError(opened.error).replace(/^vise: /, "");
      return opened;
    }
    const store = opened.value;
    const model = this.options.model();
    if (rebuild) store.clear();
    const stored = store.files();
    if (!stored.ok) return stored;
    const known = new Map(stored.value.map((f) => [f.path, f]));
    const present = listIndexable(this.options.root);
    const presentPaths = new Set(present.map((f) => f.path));
    const gone = stored.value.filter((f) => !presentPaths.has(f.path)).map((f) => f.path);
    if (gone.length > 0) store.removeFiles(gone);
    const todo = present.filter((f) => {
      const was = known.get(f.path);
      return !was || was.mtimeMs !== f.mtimeMs || was.model !== model;
    });
    const stats: SemanticUpdateStats = {
      indexed: 0,
      skipped: present.length - todo.length,
      removed: gone.length,
      failed: 0,
    };
    this.progress = { done: 0, total: todo.length };
    this.notify();
    for (const file of todo) {
      const text = readText(this.options.root, file.path);
      const chunks = text === undefined ? [] : chunkFile(text);
      if (chunks.length === 0) {
        // Binary, unreadable or blank: nothing to find, and nothing to keep from an earlier version.
        store.removeFiles([file.path]);
        stats.skipped += 1;
      } else {
        const vectors = await this.embedAll(chunks.map((c) => c.content));
        if (!vectors.ok) {
          // The embedder itself is the problem: stop, rather than fail every remaining file the same way.
          stats.failed += 1;
          this.failure = formatError(this.explain(vectors.error, model)).replace(/^vise: /, "");
          this.finish(stats, started);
          return { ok: false, error: this.explain(vectors.error, model) };
        }
        store.replaceFile(file.path, chunks, vectors.value, model, file.mtimeMs);
        stats.indexed += 1;
      }
      this.progress = { done: this.progress.done + 1, total: todo.length };
      this.notify();
    }
    this.failure = undefined;
    this.finish(stats, started);
    return { ok: true, value: stats };
  }

  private finish(stats: SemanticUpdateStats, started: number): void {
    this.options.audit?.record({
      kind: "event",
      name: "semantic_index",
      payload: { ...stats, ms: Date.now() - started },
    });
  }

  /** Embed `texts` in batches, in order. */
  private async embedAll(texts: string[]): Promise<Result<number[][]>> {
    const size = this.options.batchSize ?? BATCH;
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      const batch = await this.options.embed(texts.slice(i, i + size));
      if (!batch.ok) return batch;
      all.push(...batch.value);
    }
    return { ok: true, value: all };
  }
}
