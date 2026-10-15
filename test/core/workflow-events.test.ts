import { describe, expect, test } from "bun:test";
import type { Client } from "@vise/core";
import { runWorkflow, stepLabel } from "@vise/core";
import type { Workflow, WorkflowEvent } from "@vise/core";
import type { WorkflowCommands } from "../../packages/backend/src/repl/commands/workflow-commands.ts";
import { handleWorkflowCommand } from "../../packages/backend/src/repl/commands/workflow-commands.ts";
import type { WorkflowProfileScope } from "../../packages/backend/src/repl/commands/workflow-profiles.ts";
import { formatWorkflowEvent } from "../../packages/backend/src/output/workflow-format.ts";

const okClient: Client = {
  async chat() {
    return { ok: true, value: { content: "done" } };
  },
};

const failingClient: Client = {
  async chat() {
    return { ok: false, error: { kind: "network", cause: "socket closed" } };
  },
};

const twoSteps: Workflow = {
  steps: [
    { type: "profile", name: "default" },
    { type: "instruction", text: "## Implement\nDo the thing." },
  ],
};

const run = async (client: Client, workflow: Workflow): Promise<WorkflowEvent[]> => {
  const events: WorkflowEvent[] = [];
  await runWorkflow({
    client,
    tools: { run: async () => "" },
    toolDefs: [],
    messages: [{ role: "system", content: "s" }],
    name: "wf",
    workflow,
    request: "",
    callbacks: {},
    profiles: {
      apply: async () => ({ ok: true, value: "ok" }),
      tools: async () => ({ ok: true, value: undefined }),
      enabled: () => [],
      baseline: () => [],
    },
    onWorkflow: (event) => events.push(event),
  });
  return events;
};

describe("workflow progress events", () => {
  test("a run reports start, each step, the final response and the end", async () => {
    const events = await run(okClient, twoSteps);
    expect(events).toEqual([
      { kind: "start", name: "wf", total: 3 },
      { kind: "step", name: "wf", index: 1, total: 3, label: "profile default" },
      { kind: "profile", name: "default", was: undefined },
      { kind: "step", name: "wf", index: 2, total: 3, label: "Implement" },
      { kind: "step", name: "wf", index: 3, total: 3, label: "final response" },
      { kind: "end", name: "wf", step: 3, total: 3 },
    ]);
  });

  test("a failing step ends the run at that step with the error", async () => {
    const events = await run(failingClient, twoSteps);
    expect(events.at(-1)).toEqual({
      kind: "end",
      name: "wf",
      step: 2,
      total: 3,
      error: { kind: "network", cause: "socket closed" },
    });
  });

  test("labels are short and name the step", () => {
    expect(stepLabel({ type: "tool", name: "read_file", args: {} })).toBe("tool read_file");
    expect(stepLabel({ type: "instruction", text: `${"x".repeat(80)}\nmore` }).length).toBe(60);
  });

  test("events are formatted as one line each", () => {
    expect(formatWorkflowEvent({ kind: "start", name: "wf", total: 3 })).toBeUndefined();
    expect(
      formatWorkflowEvent({ kind: "step", name: "wf", index: 2, total: 3, label: "commit" })?.text,
    ).toBe("▸ workflow wf · step 2/3 · commit");
    expect(formatWorkflowEvent({ kind: "end", name: "wf", step: 3, total: 3 })?.level).toBe("ok");
    const failed = formatWorkflowEvent({
      kind: "end",
      name: "wf",
      step: 2,
      total: 3,
      error: { kind: "network", cause: "socket closed" },
    });
    expect(failed?.level).toBe("warn");
    expect(failed?.text).toContain("step 2/3");
    expect(failed?.text).toContain("socket closed");
  });
});

describe("profile after a workflow", () => {
  /** A session stub whose workflow switches profile "plan" → "default". */
  const harness = (client: Client) => {
    let active: string | undefined = "plan";
    const restored: (string | undefined)[] = [];
    const events: WorkflowEvent[] = [];
    const scope: WorkflowProfileScope = {
      active: "plan",
      current: () => active,
      restore: async (before) => {
        restored.push(before);
        active = before;
      },
      profiles: {
        apply: async (name) => {
          active = name;
          return { ok: true, value: "ok" };
        },
        tools: async () => ({ ok: true, value: undefined }),
        enabled: () => [],
        baseline: () => [],
      },
    };
    const session = {
      workflowSource: () => ({
        listWorkflows: async () => ({ ok: true as const, value: [] }),
        initWorkflow: async () => ({ ok: true as const, value: "x" }),
        loadWorkflow: async () => ({ ok: true as const, value: twoSteps }),
      }),
      client: () => client,
      tools: () => ({ run: async () => "" }),
      toolDefs: () => [],
      messages: () => [{ role: "system" as const, content: "s" }],
      preTurnHooks: () => [],
      postTurnHooks: () => [],
      onToken: () => undefined,
      onThinking: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onImage: () => undefined,
      onMaxRounds: () => undefined,
      onWorkflow: () => (event: WorkflowEvent) => events.push(event),
      roundHook: () => undefined,
      isToolEnabled: () => () => true,
      maybeAutoCompact: async () => ({ ok: true as const, value: "" }),
      save: async () => {},
      setSessionName: () => {},
      profileScope: () => scope,
      setCurrentAbort: () => {},
      underGoal: (_said: string, _signal: AbortSignal, first: () => unknown) => first(),
    } as unknown as WorkflowCommands;
    return { session, restored, events, active: () => active };
  };

  test("a finished run puts the profile you had back", async () => {
    const h = harness(okClient);
    const result = await handleWorkflowCommand(h.session, "/workflow wf go");
    expect(result === "exit" || result.ok).toBeTrue();
    expect(h.restored).toEqual(["plan"]);
    expect(h.active()).toBe("plan");
  });

  test("a run that stops early stays in the profile it was working in and says so", async () => {
    const h = harness(failingClient);
    const result = await handleWorkflowCommand(h.session, "/workflow wf go");
    expect(result !== "exit" && result.ok).toBeFalse();
    expect(h.restored).toEqual([]);
    expect(h.active()).toBe("default");
    expect(h.events.at(-1)).toEqual({ kind: "profile", name: "default", was: "plan" });
  });
});
