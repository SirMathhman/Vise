import { describe, expect, test } from "bun:test";
import { Channel } from "./channel.ts";

describe("Channel", () => {
  test("takes values in the order they were pushed", async () => {
    const channel = new Channel<string>();
    channel.push("a");
    channel.push("b");
    expect(await channel.next()).toBe("a");
    expect(await channel.next()).toBe("b");
  });

  test("a taker waiting before a push receives that value", async () => {
    const channel = new Channel<string>();
    const taken = channel.next();
    channel.push("late");
    expect(await taken).toBe("late");
  });

  test("each waiting taker gets its own value, in order", async () => {
    const channel = new Channel<string>();
    const first = channel.next();
    const second = channel.next();
    channel.push("one");
    channel.push("two");
    expect(await first).toBe("one");
    expect(await second).toBe("two");
  });

  test("end gives undefined to every waiting taker", async () => {
    const channel = new Channel<string>();
    const first = channel.next();
    const second = channel.next();
    channel.end();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
  });

  test("values queued before end are still taken after it", async () => {
    const channel = new Channel<string>();
    channel.push("queued");
    channel.end();
    expect(await channel.next()).toBe("queued");
    expect(await channel.next()).toBeUndefined();
  });

  test("a push after end is ignored", async () => {
    const channel = new Channel<string>();
    channel.end();
    channel.push("too late");
    expect(await channel.next()).toBeUndefined();
  });

  test("more is true while values are queued or the channel is open", () => {
    const channel = new Channel<string>();
    expect(channel.more).toBe(true);
    channel.end();
    expect(channel.more).toBe(false);
    const queued = new Channel<string>();
    queued.push("x");
    queued.end();
    expect(queued.more).toBe(true);
  });

  test("discard drops the values queued so far, and keeps later ones", async () => {
    const channel = new Channel<string>();
    channel.push("dropped");
    channel.discard();
    channel.push("kept");
    expect(await channel.next()).toBe("kept");
  });

  test("async iteration yields every value and stops at end", async () => {
    const channel = new Channel<number>();
    channel.push(1);
    channel.push(2);
    channel.end();
    const seen: number[] = [];
    for await (const value of channel) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });
});
