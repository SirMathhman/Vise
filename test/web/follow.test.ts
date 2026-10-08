import { expect, test } from "bun:test";
import { createFollower } from "../../web/src/transcript/follow.ts";

function fakeLog() {
  const listeners = new Map<string, (event?: unknown) => void>();
  const log = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
  };
  return {
    log: log as unknown as HTMLElement,
    raw: log,
    fire: (type: string) => listeners.get(type)?.(),
  };
}

test("follows the bottom, one scroll per frame", () => {
  const { log, raw } = fakeLog();
  const frames: (() => void)[] = [];
  const { follow } = createFollower(log, undefined, (work) =>
    frames.push(work),
  );
  follow();
  follow();
  follow();
  expect(frames).toHaveLength(1);
  frames[0]?.();
  expect(raw.scrollTop).toBe(1000);
});

test("a scroll up between a new line and the frame wins: the reader is not yanked down", () => {
  const { log, raw, fire } = fakeLog();
  const frames: (() => void)[] = [];
  const changes: boolean[] = [];
  const { follow } = createFollower(
    log,
    (pinned) => changes.push(pinned),
    (work) => frames.push(work),
  );
  follow();
  raw.scrollTop = 100; // the reader scrolls up before the frame
  fire("scroll");
  frames[0]?.();
  expect(raw.scrollTop).toBe(100);
  expect(changes).toEqual([false]);
});

test("jumping resumes following, and a picture that loads follows too", () => {
  const { log, raw, fire } = fakeLog();
  const frames: (() => void)[] = [];
  const { follow, jump } = createFollower(log, undefined, (work) =>
    frames.push(work),
  );
  raw.scrollTop = 0;
  fire("scroll");
  follow();
  expect(frames).toHaveLength(0); // not following
  jump();
  expect(raw.scrollTop).toBe(1000);
  fire("load"); // a picture finished loading
  expect(frames).toHaveLength(1);
});

test("content growing under a pinned log does not unpin it; scrolling up does", () => {
  const { log, raw, fire } = fakeLog();
  const frames: (() => void)[] = [];
  const changes: boolean[] = [];
  const { follow } = createFollower(log, (p) => changes.push(p), (w) => frames.push(w));
  follow();
  frames.shift()?.(); // at the bottom: 1000
  raw.scrollHeight = 1500; // a box filled up before the next frame; the browser nudged the position
  raw.scrollTop = 1010;
  fire("scroll");
  expect(changes).toEqual([]);
  follow();
  frames.shift()?.();
  expect(raw.scrollTop).toBe(1500);
  raw.scrollTop = 900; // the reader scrolls up
  fire("scroll");
  expect(changes).toEqual([false]);
});
