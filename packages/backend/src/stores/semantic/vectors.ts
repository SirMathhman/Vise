/** A vector as the bytes the database keeps (little-endian float32). */
export function encodeVector(vector: ArrayLike<number>): Uint8Array {
  const floats = Float32Array.from(vector as ArrayLike<number>);
  return new Uint8Array(floats.buffer);
}

/** The vector kept in `bytes` (a copy, so a view into a database row is never aliased or misaligned). */
export function decodeVector(bytes: Uint8Array, dims: number): Float32Array {
  const copy = bytes.slice(0, dims * 4);
  return new Float32Array(copy.buffer, 0, dims);
}

/** The length of a vector. */
export function norm(vector: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

/** Cosine similarity of two vectors of the same length (0 when either is the zero vector). */
export function cosine(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  normA = norm(a),
  normB = norm(b),
): number {
  const denom = normA * normB;
  if (denom === 0) return 0;
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot / denom;
}

/** The `limit` best-scoring items, best first. */
export function topScored<T>(
  items: { score: number; item: T }[],
  limit: number,
): { score: number; item: T }[] {
  return [...items].sort((x, y) => y.score - x.score).slice(0, Math.max(0, limit));
}
