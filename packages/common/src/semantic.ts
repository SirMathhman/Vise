/** One place in a file that is close in meaning to a query. */
export interface SemanticHit {
  /** Relative to the folder, with `/` separators. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Cosine similarity with the query (higher is closer). */
  score: number;
  /** The start of the passage, for display. */
  snippet: string;
}

/** What a semantic index is doing, for the user and for the model's tool. */
export interface SemanticStatus {
  /** `unavailable`: the embedding model cannot be used (see `reason`); `empty`: nothing indexed yet. */
  state: "unavailable" | "empty" | "indexing" | "ready";
  files: number;
  chunks: number;
  /** The embedding model the index is built with. */
  model: string;
  /** While `indexing`: files done of files to do. */
  done?: number;
  total?: number;
  /** Why it is unavailable, or what to do about an index built with another model. */
  reason?: string;
}

/** What a run of `update` did. */
export interface SemanticUpdateStats {
  indexed: number;
  /** Up to date, or unreadable/binary. */
  skipped: number;
  /** In the index but gone (or no longer indexable) and so forgotten. */
  removed: number;
  failed: number;
}
