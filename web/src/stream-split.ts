/** A reply shorter than this is simply re-rendered whole: splitting it is not worth the artifacts. */
export const MIN_FROZEN = 1500;

/**
 * Where the finished part of a streaming markdown reply ends: just after the
 * last blank line that is not inside a code fence. Everything before that point
 * will not change as more text arrives, so it can be rendered once while only
 * the open tail is rendered again on each update. Returns 0 while the text is
 * short or has no such point. The result never goes down as the text grows, so
 * a part already frozen stays valid.
 */
export function stableCut(raw: string): number {
  if (raw.length < MIN_FROZEN) return 0;
  let cut = 0;
  let inFence = false;
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf("\n", start);
    if (end === -1) break; // the last line is still being written
    const line = raw.slice(start, end);
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && line.trim() === "") cut = end + 1;
    start = end + 1;
  }
  return cut;
}
