/** How near the bottom counts as "following" the conversation, in pixels. */
const FOLLOW_SLACK = 48;

/** Run `work` before the next frame (immediately where there are no frames, as in tests). */
export function nextFrame(work: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(work);
  else work();
}

/**
 * Keeps the newest line in view only while the reader is at the bottom, so
 * reading older lines is never interrupted. `onPinned` hears each change (a
 * "jump to latest" button follows it). Scrolling happens at most once a frame.
 */
export function createFollower(
  log: HTMLElement,
  onPinned?: (pinned: boolean) => void,
): { follow(): void; jump(): void } {
  let pinned = true;
  let queued = false;
  const set = (next: boolean): void => {
    if (next === pinned) return;
    pinned = next;
    onPinned?.(next);
  };
  log.addEventListener?.("scroll", () => {
    set(log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_SLACK);
  });
  return {
    follow(): void {
      if (!pinned || queued) return;
      queued = true;
      nextFrame(() => {
        queued = false;
        log.scrollTop = log.scrollHeight;
      });
    },
    jump(): void {
      set(true);
      log.scrollTop = log.scrollHeight;
    },
  };
}
