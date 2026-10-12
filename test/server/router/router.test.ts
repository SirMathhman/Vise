import { expect, test } from "bun:test";
import type { ConnectionState } from "../../../apps/web/src/router/connection.ts";
import { handleMessage } from "../../../apps/web/src/router/router.ts";

/** A connection whose pieces record what the router asked of them. */
function fake() {
  const sent: Record<string, unknown>[] = [];
  const log: string[] = [];
  const session = {
    interrupt: () => void log.push("interrupt"),
    getActiveProfile: () => "plan",
    isBurst: () => false,
  };
  const conn = {
    send: (m: Record<string, unknown>) => sent.push(m),
    session,
    prompter: { settle: (t: string) => void log.push(`answer:${t}`) },
    edge: {
      session,
      profileSource: { listProfiles: async () => ({ ok: true as const, value: ["plan"] }) },
      toolController: { list: () => [{ name: "read_file", enabled: true }] },
      reasoning: { getReasoningEffort: () => "high" },
      sessionSource: { list: async () => ({ ok: true as const, value: [] }) },
    },
    ws: { data: { root: "/r", noFolder: false } },
    held: [],
  } as unknown as ConnectionState;
  return { conn, sent, log };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a type nobody owns, or something that is not JSON, is ignored", async () => {
  const { conn, sent, log } = fake();
  handleMessage(conn, "not json");
  handleMessage(conn, JSON.stringify({ type: "no_such_message" }));
  handleMessage(conn, JSON.stringify({ nothing: true }));
  await settle();
  expect(sent).toEqual([]);
  expect(log).toEqual([]);
});

test("interrupt and ask_answer reach the session and the prompter, never the turn queue", async () => {
  const { conn, log } = fake();
  handleMessage(conn, JSON.stringify({ type: "interrupt" }));
  handleMessage(conn, JSON.stringify({ type: "ask_answer", text: "yes" }));
  await settle();
  expect(log).toEqual(["interrupt", "answer:yes"]);
});

test("lists_get answers with the profiles, tools, reasoning level and burst state", async () => {
  const { conn, sent } = fake();
  handleMessage(conn, JSON.stringify({ type: "lists_get" }));
  await settle();
  const lists = (sent[0] as { lists: Record<string, unknown> }).lists;
  expect(sent[0]?.type).toBe("lists");
  expect(lists.profiles).toEqual({ names: ["default", "plan"], active: "plan" });
  expect(lists.reasoning).toMatchObject({ active: "high" });
  expect(lists.burst).toBe(false);
});

test("profile_tools is routed to its own handler, not the profile editor's prefix", async () => {
  const { conn, sent } = fake();
  handleMessage(conn, JSON.stringify({ type: "profile_tools", id: "x", name: "plan", read: true }));
  await settle();
  expect(sent[0]).toMatchObject({ type: "profile_tools", id: "x", ok: false });
});
