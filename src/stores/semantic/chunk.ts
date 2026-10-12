/** A window of a file: the unit that is embedded and found. */
export interface Chunk {
  /** 0-based index of the first line. */
  start: number;
  /** 0-based index of the last line (inclusive). */
  end: number;
  content: string;
}

/** Most lines in a window. */
export const CHUNK_LINES = 50;
/** Most characters in a window (a window of lines is cut short here): it must fit an embedder's context. */
export const CHUNK_CHARS = 1500;
/** Lines two neighbouring windows share, so a passage cut at a boundary is whole in one of them. */
export const CHUNK_OVERLAP = 10;
/** A single line longer than a window (minified code) is cut to this many characters. */
const MAX_CHUNK_CHARS = 4000;

/**
 * Cut a file's text into overlapping windows of at most `CHUNK_LINES` lines
 * and `CHUNK_CHARS` characters, covering every line. Windows that are only
 * whitespace are left out. Pure.
 */
export function chunkFile(content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let first = 0;
  while (first < lines.length) {
    let end = first; // exclusive
    let chars = 0;
    while (end < lines.length && end - first < CHUNK_LINES) {
      const add = (lines[end] ?? "").length + 1;
      // A window always takes at least one line, however long.
      if (end > first && chars + add > CHUNK_CHARS) break;
      chars += add;
      end += 1;
    }
    const text = lines.slice(first, end).join("\n");
    if (text.trim() !== "") {
      chunks.push({ start: first, end: end - 1, content: text.slice(0, MAX_CHUNK_CHARS) });
    }
    if (end >= lines.length) break;
    // The next window starts inside this one, but always moves forward.
    first = Math.max(end - CHUNK_OVERLAP, first + 1);
  }
  return chunks;
}
