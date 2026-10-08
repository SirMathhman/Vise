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
      if (pinned) log.scrollTop = log.scrollHeight;
    });
  };
  log.addEventListener?.("scroll", () => {
    set(log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_SLACK);
  });
  // `load` does not bubble, so listen while it travels down to the picture.
  log.addEventListener?.("load", follow, true);
  return {
    follow,
    jump(): void {
      set(true);
      log.scrollTop = log.scrollHeight;
    },
  };
}
