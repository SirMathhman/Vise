/** A reply shorter than this is simply re-rendered whole: splitting it is not worth the artifacts. */
export const MIN_FROZEN = 1500;

/** A list item, or an indented line: a block that a blank line does not end. */
const LIST_OR_INDENTED = /^(\s+\S|\s*([-*+]|\d+[.)])\s)/;
/** A line that would continue a list. */
const LIST_ITEM = /^([-*+]|\d+[.)])\s/;
/** Reference-style link definitions, and raw HTML blocks, only make sense whole. */
const NEEDS_WHOLE = /^(\[[^\]]+\]:|<[A-Za-z])/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Finds, as a reply streams in, the point before which it will not change: just
 * after a blank line that ends a plain block (a paragraph, a heading, a closed
 * code fence). It never cuts inside a code fence (the closer must repeat the
 * opener's character at least as long), inside a list (a blank line does not
 * end one), or in a reply that has reference links or raw HTML (those are left
 * to the final whole render). The text only ever grows, so each call continues
 * where the last stopped and the cost of a frame does not grow with the reply.
 * Returns 0 while the text is short or has no such point; the result never goes
 * down, so a part already frozen stays valid.
 */
export function createCutScanner(): (raw: string) => number {
  let scanned = 0; // everything before this index has been read, line by line
  let fence: { char: string; length: number } | null = null;
  let cut = 0;
  let pending = 0; // the end of a blank line waiting to see what follows it
  let previousUnsafe = false; // the last block was a list or indented
  let blocked = false;
  return (raw) => {
    if (raw.length < MIN_FROZEN) return cut;
    for (;;) {
      const end = raw.indexOf("\n", scanned);
      if (end === -1) break; // the last line is still being written
      const line = raw.slice(scanned, end);
      scanned = end + 1;
      if (fence) {
        const closer = new RegExp(
          `^ {0,3}\\${fence.char}{${fence.length},}\\s*$`,
        );
        if (closer.test(line)) fence = null;
        continue;
      }
      if (line.trim() === "") {
        if (pending === 0) pending = scanned;
        continue;
      }
      if (NEEDS_WHOLE.test(line)) blocked = true;
      const opener = FENCE_OPEN.exec(line);
      // A blank line ended the previous block: it is a cut if this line starts a new plain block.
      if (
        pending > 0 &&
        !blocked &&
        !/^\s/.test(line) &&
        !(previousUnsafe && LIST_ITEM.test(line))
      ) {
        cut = pending;
      }
      pending = 0;
      previousUnsafe = LIST_OR_INDENTED.test(line) && !opener;
      if (opener) fence = { char: opener[1]![0]!, length: opener[1]!.length };
    }
    // The next line is under way: its first character already says whether it starts a new plain block.
    const next = raw[scanned];
    if (
      pending > 0 &&
      next !== undefined &&
      !blocked &&
      !/\s/.test(next) &&
      !(previousUnsafe && /[-*+\d]/.test(next))
    ) {
      cut = pending;
    }
    return cut;
  };
}

/** One-shot form for tests and callers with the whole text at hand. */
export function stableCut(raw: string): number {
  return createCutScanner()(raw);
}
