/**
 * How near the bottom counts as "following" the conversation, in pixels. Small,
 * so that a slow drag upwards is noticed at once.
 */
const FOLLOW_SLACK = 16;

/** Run `work` before the next frame (immediately where there are no frames, as in tests). */
export function nextFrame(work: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(work);
  else work();
}

/**
 * Keeps the newest line in view only while the reader is at the bottom, so
 * reading older lines is never interrupted. `onPinned` hears each change (a
 * "jump to latest" button follows it). Scrolling happens at most once a frame,
 * and only if the reader is still at the bottom when the frame comes: a scroll
 * up in between wins. Pictures that finish loading push the bottom away, so
 * they follow too. `schedule` is the frame source (replaceable in tests).
 */
export function createFollower(
  log: HTMLElement,
  onPinned?: (pinned: boolean) => void,
  schedule: (work: () => void) => void = nextFrame,
): { follow(): void; jump(): void } {
  let pinned = true;
  let queued = false;
  /** Where the log was last scrolled to (by us or the reader): a scroll event that moved it up is the reader's. */
  let lastTop = Number.POSITIVE_INFINITY;
  const set = (next: boolean): void => {
    if (next === pinned) return;
    pinned = next;
    onPinned?.(next);
  };
  const follow = (): void => {
    if (!pinned || queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      if (pinned) {
        log.scrollTop = log.scrollHeight;
        lastTop = log.scrollTop;
      }
    });
  };
  // Content that grows (a long subagent box filling up) can move the scroll
  // position by itself, and leave the bottom further away than the slack before
  // a frame can follow it. Only a move *up* away from the bottom is the reader
  // leaving; growth alone never unpins.
  log.addEventListener?.("scroll", () => {
    const top = log.scrollTop;
    const atBottom = log.scrollHeight - top - log.clientHeight < FOLLOW_SLACK;
    if (atBottom) set(true);
    else if (top < lastTop) set(false);
    lastTop = top;
  });
  // `load` does not bubble, so listen while it travels down to the picture.
  log.addEventListener?.("load", follow, true);
  // Anything else that grows the log (a reply re-rendered as markdown, a box or
  // thinking line opening or closing, a bar changing) must keep it following
  // too, whether or not the code that changed it remembered to say so.
  if (typeof MutationObserver === "function") {
    new MutationObserver(follow).observe(log, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(follow).observe(log);
  return {
    follow,
    jump(): void {
      set(true);
      log.scrollTop = log.scrollHeight;
      lastTop = log.scrollTop;
    },
  };
}
