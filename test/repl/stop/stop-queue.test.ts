import { expect, test } from "bun:test";
import { runTurn, type Client } from "@vise/core";
import { queueLine, resumeQueue, steerLine, stopLine } from "../../../apps/web/src/conn/line.ts";
import type { LineConnection } from "../../../apps/web/src/conn/line.ts";
import { WebUserPrompter } from "../../../apps/web/src/conn/prompter.ts";
import { NoticeQueue } from "../../../packages/backend/src/repl/turn/round-hooks.ts";

/** A connection whose first line runs until it is stopped; it records every line that ran. */
function stoppableConnection(): {
  conn: LineConnection;
  sent: Record<string, unknown>[];
  ran: string[];
} {
  const sent: Record<string, unknown>[] = [];
  const ran: string[] = [];
  let stop: (() => void) | undefined;
  const conn = {
    session: {
      handleLine: (line: string) => {
        ran.push(line);
        if (line !== "long task") return Promise.resolve({ ok: true, value: "" });
        return new Promise((resolve) => {
          stop = () => resolve({ ok: false, error: { kind: "interrupted" } });
        });
      },
      interrupt: () => {
        stop?.();
        return stop !== undefined;
      },
      contextReport: async () => ({ ok: true, value: "" }),
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
  return { conn, sent, ran };
}

const queued = (sent: Record<string, unknown>[]): string[] => {
  const last = sent.findLast((m) => m.type === "queue") as
    { items: { text: string }[] } | undefined;
  return last?.items.map((i) => i.text) ?? [];
};

test("after Stop nothing lined up runs: held lines wait and unread steering is held", async () => {
  const { conn, sent, ran } = stoppableConnection();
  queueLine(conn, "long task", undefined, undefined);
  await Bun.sleep(1);
  steerLine(conn, "also do this", undefined);
  queueLine(conn, "next thing", undefined, undefined, "q1");
  await Bun.sleep(1);
  stopLine(conn);
  await conn.chain;
  expect(ran).toEqual(["long task"]);
  expect(queued(sent).sort()).toEqual(["also do this", "next thing"]);
  expect(sent.findLast((m) => m.type === "state")).toMatchObject({ running: false, paused: true });
});

test("resuming runs the held lines in order", async () => {
  const { conn, ran } = stoppableConnection();
  queueLine(conn, "long task", undefined, undefined);
  queueLine(conn, "first", undefined, undefined, "q1");
  queueLine(conn, "second", undefined, undefined, "q2");
  await Bun.sleep(1);
  stopLine(conn);
  await conn.chain;
  resumeQueue(conn);
  await conn.chain;
  await conn.chain;
  expect(ran).toEqual(["long task", "first", "second"]);
  expect(conn.held).toEqual([]);
});

test("a new line after Stop runs, ends the pause, and the held lines follow it", async () => {
  const { conn, ran } = stoppableConnection();
  queueLine(conn, "long task", undefined, undefined);
  queueLine(conn, "held", undefined, undefined, "q1");
  await Bun.sleep(1);
  stopLine(conn);
  await conn.chain;
  queueLine(conn, "typed after stop", undefined, undefined);
  await conn.chain;
  await conn.chain;
  expect(ran).toEqual(["long task", "typed after stop", "held"]);
  expect(conn.paused).toBe(false);
});

test("Stop with nothing running or held does not pause", async () => {
  const { conn } = stoppableConnection();
  stopLine(conn);
  expect(conn.paused).toBeUndefined();
});

test("Stop closes an open question on the page", async () => {
  const sent: Record<string, unknown>[] = [];
  const prompter = new WebUserPrompter((m) => sent.push(m));
  const answer = prompter.ask({ question: "which?", options: ["a", "b"] });
  prompter.cancel();
  expect(await answer).toBe("");
  expect(sent.map((m) => m.type)).toEqual(["ask", "ask_cancel"]);
  prompter.cancel(); // nothing open: no message
  expect(sent).toHaveLength(2);
});

test("Stop while the turn asks whether to go on after many rounds ends it", async () => {
  const controller = new AbortController();
  const call = { type: "function", id: "c", function: { name: "t", arguments: "{}" } } as const;
  const client: Client = {
    chat: async () => ({ ok: true, value: { content: "", tool_calls: [call] } }),
  };
  let asked!: () => void;
  const question = new Promise<void>((r) => (asked = r));
  const turn = runTurn(client, { run: async () => "ok" }, [], [], {
    abort: controller.signal,
    onMaxRounds: () => {
      asked();
      return new Promise<boolean>(() => undefined); // nobody answers
    },
  });
  await question;
  controller.abort();
  expect(await turn).toEqual({ ok: false, error: { kind: "interrupted" } });
});
