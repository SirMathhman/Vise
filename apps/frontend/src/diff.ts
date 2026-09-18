/**
 * Pure line-diff math for showing a single edit_file call as an inline
 * unified diff in the file viewer (dual gutters, red removed / green added
 * rows — the same shape most editors show a git diff in). DOM-free so it's
 * unit-testable; `components/fileTree.ts` is the only renderer.
 */

/** One rendered row of a single-hunk diff. */
export interface DiffRow {
  /** The line's number in the original file, or null for an added row. */
  oldNum: number | null;
  /** The line's number in the resulting file, or null for a removed row. */
  newNum: number | null;
  marker: "" | "-" | "+";
  text: string;
}

/**
 * Clamp an edit_file range exactly the way the backend does (llmFs.ts's
 * editFileRange): `endLine` may run past the file's length to mean "through
 * the last line," so it's capped at `lineCount + 1` before use. Kept in sync
 * deliberately — this only decides which lines the *preview* marks changed,
 * not the authoritative edit, but a mismatch would show the wrong lines.
 */
export function clampEditRange(
  startLine: number,
  endLine: number,
  lineCount: number
): { start: number; end: number } {
  const clampedEnd = Math.min(endLine, lineCount + 1);
  return { start: startLine, end: Math.max(startLine, clampedEnd) };
}

/**
 * Build the full row list for a single-hunk diff: the file's lines outside
 * `[startLine, endLine)` as unchanged context (both gutters numbered, no
 * marker), the original lines in that range as removed (red, old gutter
 * only), and `newLines` as added (green, new gutter only — numbered from
 * `startLine` on, i.e. as if this is the only edit applied to the file).
 * 1-based, end-exclusive, matching edit_file's own line semantics; callers
 * should clamp `startLine`/`endLine` with {@link clampEditRange} first.
 */
export function buildDiffRows(
  lines: string[],
  startLine: number,
  endLine: number,
  newLines: string[]
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let i = 1; i < startLine; i++) {
    rows.push({ oldNum: i, newNum: i, marker: "", text: lines[i - 1] ?? "" });
  }
  for (let i = startLine; i < endLine; i++) {
    rows.push({
      oldNum: i,
      newNum: null,
      marker: "-",
      text: lines[i - 1] ?? "",
    });
  }
  newLines.forEach((text, i) => {
    rows.push({ oldNum: null, newNum: startLine + i, marker: "+", text });
  });
  const delta = newLines.length - (endLine - startLine);
  for (let i = endLine; i <= lines.length; i++) {
    rows.push({
      oldNum: i,
      newNum: i + delta,
      marker: "",
      text: lines[i - 1] ?? "",
    });
  }
  return rows;
}
