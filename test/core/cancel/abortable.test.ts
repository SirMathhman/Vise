import { expect, test } from "bun:test";
import { abortable, abortableResult } from "../../../packages/core/src/cancel/abortable.ts";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

test("resolves with the work's value when not aborted", async () => {
  expect(await abortable(new AbortController().signal, Promise.resolve(7))).toEqual({
    ok: true,
    value: 7,
  });
  expect(await abortable(undefined, 3)).toEqual({ ok: true, value: 3 });
});

test("an abort ends a wait on work that never finishes", async () => {
  const controller = new AbortController();
  const waiting = abortable(controller.signal, never<number>());
  controller.abort();
  expect(await waiting).toEqual({ ok: false, error: { kind: "interrupted" } });
});

test("an already aborted signal resolves at once and swallows a later rejection", async () => {
  const controller = new AbortController();
  controller.abort();
  const failing = new Promise<number>((_, reject) =>
    setTimeout(() => reject(new Error("late")), 1),
  );
  expect(await abortable(controller.signal, failing)).toEqual({
    ok: false,
    error: { kind: "interrupted" },
  });
  await Bun.sleep(5);
});

test("a rejection after the abort is dropped, one before it is passed on", async () => {
  const controller = new AbortController();
  let fail!: (e: Error) => void;
  const work = new Promise<number>((_, reject) => (fail = reject));
  const waiting = abortable(controller.signal, work);
  controller.abort();
  fail(new Error("late"));
  expect((await waiting).ok).toBe(false);
  expect(abortable(new AbortController().signal, Promise.reject(new Error("x")))).rejects.toThrow(
    "x",
  );
});

test("abortableResult flattens a Result", async () => {
  expect(
    await abortableResult(undefined, Promise.resolve({ ok: true, value: 1 } as const)),
  ).toEqual({
    ok: true,
    value: 1,
  });
  const controller = new AbortController();
  const waiting = abortableResult(controller.signal, never());
  controller.abort();
  expect(await waiting).toEqual({ ok: false, error: { kind: "interrupted" } });
});
