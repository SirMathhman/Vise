import { expect, test } from "bun:test";
import type { Client, Tool, ToolRunner } from "@vise/core";
import type { ContextSource, SessionSource } from "../../src/repl/session.ts";
import { Session } from "../../src/repl/session.ts";
import { ToolSet } from "../../src/tools.ts";

const def = (name: string): Tool => ({
  type: "function",
  function: { name, description: "", parameters: {} },
});
const client: Client = {
  async chat() {
    return { ok: true, value: { content: "reply" } };
  },
};
const runner: ToolRunner = { run: async () => "out" };
const context: ContextSource = {
  lastPromptTokensUsed: () => undefined,
  async contextMax() {
    return { ok: true, value: 100_000 };
  },
};

test("/resume re-applies the restored profile's tool whitelist, as /new does", async () => {
  const controller = new ToolSet([def("read_file"), def("delete_file")]);
  const profileSource = {
    listProfiles: async () => ({ ok: true as const, value: ["strict"] }),
    loadProfile: async () => ({ ok: true as const, value: "body" }),
    initProfile: async (n: string) => ({ ok: true as const, value: n }),
    profileTools: async () => ({ ok: true as const, value: ["read_file"] }),
    setProfileTools: async (n: string) => ({ ok: true as const, value: n }),
  };
  const sessionSource: SessionSource = {
    async save() {
      return { ok: true, value: "id" };
    },
    async list() {
      return { ok: true, value: [] };
    },
    async load(id: string) {
      return {
        ok: true,
        value: {
          id,
          name: "old",
          messages: [{ role: "system", content: "s" }],
          activeProfile: "strict",
          savedAt: "t",
        },
      };
    },
    async delete() {
      return { ok: true, value: "deleted" };
    },
  } as unknown as SessionSource;
  const session = new Session(client, runner, [], {
    cwd: "/tmp",
    context,
    preTurnHooks: [],
    postTurnHooks: [],
    profileSource,
    sessionSource,
    toolController: controller,
  });
  const result = await session.handleLine("/resume abc");
  expect(result !== "exit" && result.ok).toBe(true);
  expect(controller.list()).toEqual([
    { name: "read_file", enabled: true },
    { name: "delete_file", enabled: false },
  ]);
});
