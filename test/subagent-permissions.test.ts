import { expect, test } from "bun:test";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import { Session } from "../src/repl/session.ts";
import { createToolRunner, ToolSet } from "../src/tools.ts";
import { withToolScope } from "../src/tools/agent/agent-scope.ts";
import { makeSubagentHandler } from "../src/tools/agent/subagent.ts";

const def = (name: string): Tool => ({
  type: "function",
  function: { name, description: "", parameters: {} },
});
const defs = ["read_file", "save_note", "run_subagent", "browser_run_code"].map(
  def,
);

test("a subagent limited by its profile may use exactly its tools, whatever the session has enabled", async () => {
  const controller = new ToolSet(defs);
  controller.set("read_file", false); // the main agent is restricted away from reading
  const runner = createToolRunner(
    { read_file: async () => "contents" },
    controller,
    ".",
    defs,
  );
  expect(await runner.run("read_file", {})).toBe(
    "error: tool read_file is disabled",
  );
  const inside = await withToolScope(new Set(["read_file"]), () =>
    runner.run("read_file", {}),
  );
  expect(inside).toBe("contents");
  const refused = await withToolScope(new Set(["read_file"]), () =>
    runner.run("save_note", {}),
  );
  expect(refused).toBe("error: tool save_note is not available to this agent");
});

function subagentThatReports(
  seen: { enabled: string[] },
  whitelist?: string[],
) {
  const client: Client = {
    chat: async (_m, _t, _a, _b, _c, _d, _e, isToolEnabled) => {
      seen.enabled = defs
        .map((d) => d.function.name)
        .filter((n) => isToolEnabled?.(n) ?? true);
      return { ok: true, value: { content: "done" } };
    },
  };
  const profileSource = {
    loadProfile: async () => ({ ok: true as const, value: "profile text" }),
    profileTools: async () => ({ ok: true as const, value: whitelist }),
  };
  const runner: ToolRunner = { run: async () => "" };
  return makeSubagentHandler(
    client,
    profileSource as never,
    "/work",
    runner,
    defs,
    {},
    undefined,
    undefined,
    // The user's own settings: everything but the risky tool.
    (name) => name !== "browser_run_code",
  );
}

test("a subagent with a tool list of its own gets that list (not the main agent's)", async () => {
  const seen = { enabled: [] as string[] };
  await subagentThatReports(seen, ["read_file"])({
    task: "look",
    profile: "explore",
  });
  expect(seen.enabled).toEqual(["read_file"]);
});

test("a subagent without a tool list gets the user's own settings, not the main agent's restriction", async () => {
  const seen = { enabled: [] as string[] };
  await subagentThatReports(seen)({ task: "look", profile: "plain" });
  expect(seen.enabled).toEqual(["read_file", "save_note", "run_subagent"]);
});

test("a profile's tool restriction leaves the user's own settings readable, and lifting it forgets them", async () => {
  const controller = new ToolSet(defs);
  controller.set("browser_run_code", false);
  const whitelists: Record<string, string[] | undefined> = {
    strict: ["save_note"],
  };
  const session = new Session(
    { chat: async () => ({ ok: true, value: { content: "" } }) },
    { run: async () => "" },
    [],
    {
      cwd: "/tmp",
      context: {
        lastPromptTokensUsed: () => undefined,
        contextMax: async () => ({ ok: true, value: 100000 }),
      },
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource: {
        listProfiles: async () => ({ ok: true as const, value: ["strict"] }),
        loadProfile: async () => ({ ok: true as const, value: "body" }),
        initProfile: async (n: string) => ({ ok: true as const, value: n }),
        profileTools: async (n: string) => ({
          ok: true as const,
          value: whitelists[n],
        }),
        setProfileTools: async (n: string) => ({ ok: true as const, value: n }),
      },
      toolController: controller,
    },
  );
  await session.handleLine("/profile strict");
  expect(controller.isEnabled("read_file")).toBe(false);
  expect(controller.baselineEnabled("read_file")).toBe(true);
  expect(controller.baselineEnabled("browser_run_code")).toBe(false);
  await session.handleLine("/profile default");
  expect(controller.baselineEnabled("read_file")).toBe(
    controller.isEnabled("read_file"),
  );
});
