import { expect, test } from "bun:test";
import { createGate } from "../../apps/web/src/conn/gate.ts";

type Socket = { id: number };

function setup(ready: Promise<unknown>) {
  const log: string[] = [];
  const gate = createGate<Socket, { id: number }, string>({
    start: () => ready,
    open: (ws) => {
      log.push("open");
      return { id: ws.id };
    },
    handle: (_conn, message) => log.push(`handle ${message}`),
    teardown: () => log.push("teardown"),
    abandon: () => log.push("abandon"),
    fail: () => log.push("fail"),
  });
  return { gate, log };
}

test("messages sent before the connection is ready are handled in order, after it opens", async () => {
  let release!: () => void;
  const { gate, log } = setup(new Promise<void>((r) => (release = r)));
  const ws = { id: 1 };
  gate.open(ws);
  gate.message(ws, "a");
  gate.message(ws, "b");
  expect(log).toEqual([]);
  release();
  await Promise.resolve();
  await Promise.resolve();
  gate.message(ws, "c");
  expect(log).toEqual(["open", "handle a", "handle b", "handle c"]);
});

test("a page that closes while starting is abandoned once and never opened", async () => {
  let release!: () => void;
  const { gate, log } = setup(new Promise<void>((r) => (release = r)));
  const ws = { id: 1 };
  gate.open(ws);
  gate.message(ws, "a");
  gate.close(ws);
  release();
  await Promise.resolve();
  await Promise.resolve();
  gate.close(ws);
  expect(log).toEqual(["abandon"]);
});

test("a start that fails is abandoned and reported", async () => {
  const { gate, log } = setup(Promise.reject(new Error("no")));
  gate.open({ id: 1 });
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["abandon", "fail"]);
});
