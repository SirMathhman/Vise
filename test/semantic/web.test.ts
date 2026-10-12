import { expect, test } from "bun:test";
import type { SemanticHit, SemanticIndexPort, SemanticStatus } from "../../src/repl/ports.ts";
import type { ConnectionState } from "../../src/web/router/connection.ts";
import { handleMessage } from "../../src/web/router/router.ts";
import { hitLocation, statusText } from "../../web/src/workspace/search/semantic-search.ts";

const hit: SemanticHit = { path: "src/auth.ts", startLine: 3, endLine: 20, score: 0.77, snippet: "login()" };

function index(status: Partial<SemanticStatus> = {}) {
  const calls: string[] = [];
  const port: SemanticIndexPort = {
    search: async (query, limit) => {
      calls.push(`search:${query}:${limit}`);
      return { ok: true, value: [hit] };
    },
    status: () => ({ state: "ready", files: 1, chunks: 2, model: "m", ...status }),
    update: async (options) => {
      calls.push(options?.rebuild ? "rebuild" : "update");
      return { ok: true, value: { indexed: 0, skipped: 0, removed: 0, failed: 0 } };
    },
    onChange: () => () => undefined,
  };
  return { port, calls };
}

function connection(semantic: SemanticIndexPort | undefined) {
  const sent: Record<string, unknown>[] = [];
  const conn = {
    send: (m: Record<string, unknown>) => sent.push(m),
    edge: { semantic },
  } as unknown as ConnectionState;
  return { conn, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("sem_search is answered with the hits and the index's status, limit clamped", async () => {
  const { port, calls } = index();
  const { conn, sent } = connection(port);
  handleMessage(conn, JSON.stringify({ type: "sem_search", query: " how are sessions saved ", limit: 500 }));
  await settle();
  expect(calls).toEqual(["search:how are sessions saved:25"]);
  expect(sent[0]).toMatchObject({ type: "sem_results", query: "how are sessions saved", hits: [hit] });
  expect((sent[0] as { status: SemanticStatus }).status.state).toBe("ready");
});

test("an empty query is not searched; a failed search carries its error and the status", async () => {
  const { port, calls } = index();
  const { conn, sent } = connection(port);
  handleMessage(conn, JSON.stringify({ type: "sem_search", query: "   " }));
  await settle();
  expect(calls).toEqual([]);
  expect(sent[0]).toMatchObject({ type: "sem_results", hits: [] });

  const failing: SemanticIndexPort = {
    ...port,
    search: async () => ({ ok: false, error: { kind: "malformed", body: "cannot embed" } }),
  };
  const second = connection(failing);
  handleMessage(second.conn, JSON.stringify({ type: "sem_search", query: "x" }));
  await settle();
  expect(String(second.sent[0]?.["error"])).toContain("cannot embed");
});

test("sem_rebuild starts a rebuild and answers with the status; sem_status reports it", async () => {
  const { port, calls } = index({ state: "indexing", done: 1, total: 4 });
  const { conn, sent } = connection(port);
  handleMessage(conn, JSON.stringify({ type: "sem_rebuild" }));
  handleMessage(conn, JSON.stringify({ type: "sem_status" }));
  await settle();
  expect(calls).toEqual(["rebuild"]);
  expect(sent.map((m) => m["type"])).toEqual(["sem_status", "sem_status"]);
});

test("a session with no folder has no semantic status", async () => {
  const { conn, sent } = connection(undefined);
  handleMessage(conn, JSON.stringify({ type: "sem_search", query: "x" }));
  await settle();
  expect(sent).toEqual([{ type: "sem_status", status: null }]);
});

test("the page names a hit by path and lines, and shows the index's own status text", () => {
  expect(hitLocation(hit)).toBe("src/auth.ts:3-20");
  expect(statusText({ state: "ready", files: 2, chunks: 9, model: "m" })).toContain("2 files");
});
