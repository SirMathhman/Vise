import { expect, test } from "bun:test";
import { queueLine } from "../../apps/web/src/conn/line.ts";
import type { LineConnection } from "../../apps/web/src/conn/line.ts";
import { NoticeQueue } from "../../packages/backend/src/repl/turn/round-hooks.ts";

function fakeConnection(canSee = true): {
  conn: LineConnection;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const conn = {
    session: {
      handleLine: async () => ({ ok: true, value: "" }),
      contextReport: async () => ({ ok: true, value: "" }),
      notices: new NoticeQueue(),
      getSessionId: () => undefined,
    },
    display: { reset() {}, wasStreamed: false },
    send: (msg: Record<string, unknown>) => sent.push(msg),
    edge: { canSeeImages: async () => canSee },
    dataDir: "/nowhere",
    lease: { follow() {}, heldByOther: () => false },
    chain: Promise.resolve(),
    held: [],
    running: false,
  } as unknown as LineConnection;
  return { conn, sent };
}

const summary = (sent: Record<string, unknown>[]): string[] =>
  sent.map((m) =>
    m.type === "state"
      ? `state:${m.running ? "run" : "idle"}`
      : `${m.type}${m.id ? `:${m.id}` : ""}`,
  );

test("a user line is announced as started and running, then idle; a background request (with an id) never changes the state", async () => {
  const { conn, sent } = fakeConnection();
  queueLine(conn, "hello", undefined, undefined);
  queueLine(conn, "/tool", "ed1", undefined);
  await conn.chain;
  expect(summary(sent)).toEqual([
    "line_started",
    "state:run",
    "result",
    "state:idle",
    "result:ed1",
  ]);
});

test("a command is not steerable, a plain line is", async () => {
  const { conn, sent } = fakeConnection();
  queueLine(conn, "/model", undefined, undefined);
  queueLine(conn, "hi", undefined, undefined);
  await conn.chain;
  const running = sent.filter((m) => m.type === "state" && m.running);
  expect(running.map((m) => m.steerable)).toEqual([false, true]);
});

test("a refused line still ends in an idle state, so the page can never stay locked", async () => {
  const { conn, sent } = fakeConnection(false);
  queueLine(conn, "look", undefined, [
    { uri: "data:image/png;base64,AAAA", label: "x" },
  ]);
  await conn.chain;
  expect(summary(sent).at(-1)).toBe("state:idle");
  expect(sent.some((m) => m.type === "result" && m.ok === false)).toBe(true);
});
