import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWorkflow } from "../../src/core/workflow.ts";
import type { Client, Tool, ToolRunner } from "../../src/core/engine.ts";
import type { Message } from "../../src/core/errors.ts";
import type { ContextSource, WorkflowSource } from "../../src/repl/session.ts";
import { Session } from "../../src/repl/session.ts";
import { initWorkflow, listWorkflows, loadWorkflow } from "../../src/stores/workflows.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(import.meta.dir, "workflow-fixtures-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("workflow storage (edge)", () => {
  test("initializes, lists, and loads JSON workflows", () => {
    const project = join(root, "project");
    const global = join(root, "global");
    initWorkflow(project, "review");
    expect(loadWorkflow(project, global, "review")).toEqual({
      steps: [
        { type: "instruction", text: "TODO: describe the required step" },
      ],
    });
    expect(listWorkflows(project, global)).toEqual([
      { name: "review", scope: "project", active: true },
    ]);
  });

  test("project workflows shadow global definitions while listing both", () => {
    const project = join(root, "shadow-project");
    const global = join(root, "shadow-global");
    mkdirSync(join(project, "workflows"), { recursive: true });
    mkdirSync(join(global, "workflows"), { recursive: true });
    writeFileSync(
      join(project, "workflows", "review.json"),
      JSON.stringify({ steps: [] }),
    );
    writeFileSync(
      join(global, "workflows", "review.json"),
      JSON.stringify({ steps: [] }),
    );
    expect(listWorkflows(project, global)).toEqual([
      { name: "review", scope: "project", active: true },
      { name: "review", scope: "global", active: false },
    ]);
    expect(loadWorkflow(project, global, "review")).toEqual({ steps: [] });
  });
});

describe("runWorkflow (core)", () => {
  const toolDefs: Tool[] = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            encoding: { type: "string" },
          },
          required: ["path"],
        },
      },
    },
  ];

  test("runs instruction phases, constrained tool steps, and final turn in sequence", async () => {
    const events: string[] = [];
    const visibleTools: string[] = [];
    const client: Client = {
      async chat(messages, tools, _onToken, _onThinking, _progress, schema) {
        if (schema) {
          events.push("generate-args");
          expect(tools).toBeUndefined();
          expect(schema).toEqual({
            type: "object",
            properties: {
              path: { type: "string" },
              encoding: { type: "string" },
            },
            required: ["path", "encoding"],
          });
          expect(
            messages.some(
              (message) => message.content === "instruction tool output",
            ),
          ).toBeTrue();
          return {
            ok: true,
            value: { content: '{"path":"README.md","encoding":"utf8"}' },
          };
        }
        if (tools) {
          const instruction = messages.find((message) =>
            message.content.startsWith("Workflow instruction"),
          );
          if (instruction && !events.includes("instruction-finished")) {
            if (!events.includes("instruction-tool-round")) {
              events.push("instruction-tool-round");
              return {
                ok: true,
                value: {
                  content: "",
                  tool_calls: [
                    {
                      type: "function",
                      id: "instruction-call",
                      function: {
                        name: "read_file",
                        arguments: '{"path":"."}',
                      },
                    },
                  ],
                },
              };
            }
            events.push("instruction-finished");
            return { ok: true, value: { content: "instruction complete" } };
          }
          events.push("final-turn");
          return { ok: true, value: { content: "workflow complete" } };
        }
        throw new Error("unexpected model call");
      },
    };
    const runner: ToolRunner = {
      async run(name, args) {
        events.push(`run:${name}:${String(args.path)}`);
        return args.path === "." ? "instruction tool output" : "step output";
      },
    };
    const messages: Message[] = [{ role: "system", content: "system" }];
    const result = await runWorkflow({
      client,
      tools: runner,
      toolDefs,
      messages,
      name: "sample",
      workflow: {
        steps: [
          { type: "instruction", text: "Inspect the task" },
          {
            type: "tool",
            name: "read_file",
            args: { path: "<path>", encoding: "<encoding>" },
          },
        ],
      },
      request: "Review the project",
      callbacks: { onToolCall: (name) => visibleTools.push(name) },
    });

    expect(result).toEqual({ ok: true, value: "workflow complete" });
    expect(events).toEqual([
      "instruction-tool-round",
      "run:read_file:.",
      "instruction-finished",
      "generate-args",
      "run:read_file:README.md",
      "final-turn",
    ]);
    expect(
      messages.some((message) => message.content.includes("step output")),
    ).toBeTrue();
    expect(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content === '{"path":"README.md","encoding":"utf8"}',
      ),
    ).toBeTrue();
    expect(
      messages.filter(
        (message) => message.role === "assistant" && message.tool_calls,
      ),
    ).toHaveLength(1);
    expect(
      messages.some(
        (message) =>
          message.role === "user" &&
          message.content.startsWith("Workflow tool step 2 result"),
      ),
    ).toBeTrue();
    expect(visibleTools).toEqual(["read_file", "read_file"]);
  });

  test("stops with an error when a forced tool step fails", async () => {
    const client: Client = {
      async chat(_messages, _tools, _token, _thinking, _progress, schema) {
        if (!schema) throw new Error("only args generation should run");
        return { ok: true, value: { content: '{"path":"missing.txt"}' } };
      },
    };
    const runner: ToolRunner = {
      async run() {
        return "error: file not found";
      },
    };
    const result = await runWorkflow({
      client,
      tools: runner,
      toolDefs,
      messages: [{ role: "system", content: "system" }],
      name: "sample",
      workflow: {
        steps: [{ type: "tool", name: "read_file", args: { path: "<path>" } }],
      },
      request: "",
      callbacks: {},
    });
    expect(result.ok).toBeFalse();
    if (!result.ok && result.error.kind === "malformed") {
      expect(result.error.body).toContain("workflow tool 'read_file' failed");
    }
  });

  test("rejects schema-invalid generated arguments without executing the tool", async () => {
    let toolRuns = 0;
    const client: Client = {
      async chat(_messages, _tools, _token, _thinking, _progress, schema) {
        if (!schema) throw new Error("only args generation should run");
        return { ok: true, value: { content: '{"path":42}' } };
      },
    };
    const runner: ToolRunner = {
      async run() {
        toolRuns += 1;
        return "should not execute";
      },
    };
    const result = await runWorkflow({
      client,
      tools: runner,
      toolDefs,
      messages: [{ role: "system", content: "system" }],
      name: "sample",
      workflow: {
        steps: [{ type: "tool", name: "read_file", args: { path: "<path>" } }],
      },
      request: "",
      callbacks: {},
    });
    expect(result.ok).toBeFalse();
    expect(toolRuns).toBe(0);
    if (!result.ok && result.error.kind === "malformed") {
      expect(result.error.body).toContain("argument 'path' must be string");
    }
  });

  test("returns interrupted when the turn's abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const client: Client = {
      async chat() {
        called = true;
        return { ok: true, value: { content: "should not run" } };
      },
    };
    const result = await runWorkflow({
      client,
      tools: {
        async run() {
          return "out";
        },
      },
      toolDefs,
      messages: [{ role: "system", content: "system" }],
      name: "sample",
      workflow: { steps: [{ type: "instruction", text: "Do it" }] },
      request: "",
      callbacks: { abort: controller.signal },
    });
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error).toEqual({ kind: "interrupted" });
    expect(called).toBeFalse();
  });
});

describe("Session /workflow command (core)", () => {
  const context: ContextSource = {
    lastPromptTokensUsed: () => undefined,
    async contextMax() {
      return { ok: true, value: 100_000 };
    },
  };

  test("lists workflows and creates project or global definitions", async () => {
    const initialized: [string, "project" | "global"][] = [];
    const source: WorkflowSource = {
      async listWorkflows() {
        return {
          ok: true,
          value: [
            { name: "review", scope: "project", active: true },
            { name: "review", scope: "global", active: false },
          ],
        };
      },
      async loadWorkflow() {
        return { ok: true, value: { steps: [] } };
      },
      async initWorkflow(name, scope) {
        initialized.push([name, scope]);
        return { ok: true, value: name };
      },
    };
    const client: Client = {
      async chat() {
        return { ok: true, value: { content: "done" } };
      },
    };
    const session = new Session(client, { run: async () => "" }, [], {
      cwd: "/tmp",
      context,
      workflowSource: source,
      preTurnHooks: [],
      postTurnHooks: [],
    });

    const listed = await session.handleLine("/workflow");
    if (listed === "exit" || !listed.ok)
      throw new Error("expected workflow list");
    expect(listed.value).toContain("review [project] (active)");
    expect(listed.value).toContain("review [global] (shadowed)");

    await session.handleLine("/workflow init local");
    await session.handleLine("/workflow init --global shared");
    expect(initialized).toEqual([
      ["local", "project"],
      ["shared", "global"],
    ]);
  });

  test("passes trailing user input into the workflow and returns its final answer", async () => {
    let requestSeen = "";
    const autoSavedNames: string[] = [];
    const source: WorkflowSource = {
      async listWorkflows() {
        return { ok: true, value: [] };
      },
      async loadWorkflow(name) {
        expect(name).toBe("review");
        return { ok: true, value: { steps: [] } };
      },
      async initWorkflow(name) {
        return { ok: true, value: name };
      },
    };
    const client: Client = {
      async chat(messages) {
        requestSeen =
          messages.find((message) => message.content.startsWith("Run workflow"))
            ?.content ?? "";
        return { ok: true, value: { content: "review complete" } };
      },
    };
    const session = new Session(client, { run: async () => "" }, [], {
      cwd: "/tmp",
      context,
      workflowSource: source,
      sessionSource: {
        async save(_id, name) {
          autoSavedNames.push(name);
          return { ok: true, value: "session-id" };
        },
        async load() {
          return { ok: false, error: { kind: "malformed", body: "unused" } };
        },
        async list() {
          return { ok: true, value: [] };
        },
        async delete() {
          return { ok: true, value: "session-id" };
        },
      },
      preTurnHooks: [],
      postTurnHooks: [],
    });
    const result = await session.handleLine(
      "/workflow review Check the auth changes",
    );
    if (result === "exit" || !result.ok)
      throw new Error("expected workflow success");
    expect(result.value).toBe("review complete");
    expect(autoSavedNames).toEqual(["Check the auth changes"]);
    expect(requestSeen).toContain("Check the auth changes");
  });
});
