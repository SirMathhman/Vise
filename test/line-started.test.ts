import { expect, test } from "bun:test";
import { queueLine } from "../src/web/line.ts";
import type { LineConnection } from "../src/web/line.ts";
import { NoticeQueue } from "../src/repl/round-hooks.ts";

function fakeConnection(): { conn: LineConnection; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const conn = {
    session: {
      handleLine: async () => ({ ok: true, value: "" }),
      notices: new NoticeQueue(),
      getSessionId: () => undefined,
    },
    display: { reset() {}, wasStreamed: false },
    send: (msg: Record<string, unknown>) => sent.push(msg),
    edge: { canSeeImages: async () => true },
    dataDir: "/nowhere",
    lease: { follow() {}, heldByOther: () => false },
    chain: Promise.resolve(),
    held: [],
    running: false,
  } as unknown as LineConnection;
  return { conn, sent };
}

test("a user line is announced as started, a background request (with an id) is not", async () => {
  const { conn, sent } = fakeConnection();
  queueLine(conn, "hello", undefined, undefined);
  queueLine(conn, "/tool", "ed1", undefined);
  await conn.chain;
  const types = sent.map((m) => `${m.type}${m.id ? `:${m.id}` : ""}`);
  expect(types).toEqual(["line_started", "result", "result:ed1"]);
});
