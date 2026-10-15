import { describe, expect, test } from "bun:test";
import {
  parse,
  parseJson,
  todosSchema,
  parseTodos,
  messageSchema,
  toolCallsArraySchema,
  pictureSchema,
  goalTraceFactSchema,
  workflowSchema,
  mcpServerSpecSchema,
  auditEventSchema,
  auditCallSchema,
  toolCallArgsSchema,
  validateSettingValue,
  parseProfileText,
  type TodoItem,
  type Message,
  type ToolCall,
  type Picture,
  type GoalTraceFact,
  type Workflow,
  type AuditEvent,
  type AuditCall,
} from "@vise/core";
import { z } from "zod";

describe("parseTodos (schema)", () => {
  test("accepts a valid list", () => {
    const items: TodoItem[] = [
      { content: "write code", status: "pending" },
      { content: "review", status: "in_progress" },
    ];
    const result = parseTodos(items);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(items);
  });

  test("rejects non-array", () => {
    const result = parseTodos("not an array");
    expect(result.ok).toBe(false);
  });

  test("rejects item without content", () => {
    const result = parseTodos([{ status: "pending" }]);
    expect(result.ok).toBe(false);
  });

  test("rejects item with bad status", () => {
    const result = parseTodos([{ content: "x", status: "done" }]);
    expect(result.ok).toBe(false);
  });

  test("empty array is valid", () => {
    const result = parseTodos([]);
    expect(result.ok).toBe(true);
  });
});

describe("todosSchema", () => {
  test("valid todos pass", () => {
    const result = parse(todosSchema, [{ content: "a", status: "completed" }]);
    expect(result.ok).toBe(true);
  });

  test("null content fails", () => {
    const result = parse(todosSchema, [{ content: null, status: "pending" }]);
    expect(result.ok).toBe(false);
  });

  test("empty content fails", () => {
    const result = parse(todosSchema, [{ content: "", status: "pending" }]);
    expect(result.ok).toBe(false);
  });
});

describe("toolCallsArraySchema", () => {
  test("valid tool calls pass", () => {
    const calls: ToolCall[] = [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ];
    const result = parse(toolCallsArraySchema, calls);
    expect(result.ok).toBe(true);
  });

  test("non-array fails", () => {
    const result = parse(toolCallsArraySchema, { not: "array" });
    expect(result.ok).toBe(false);
  });

  test("missing id fails", () => {
    const result = parse(toolCallsArraySchema, [
      { type: "function", function: { name: "x", arguments: "{}" } },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("pictureSchema", () => {
  test("valid picture passes", () => {
    const pic: Picture = {
      id: "pic1",
      mime: "image/png",
      label: "screenshot",
      bytes: 1024,
    };
    const result = parse(pictureSchema, pic);
    expect(result.ok).toBe(true);
  });

  test("missing id fails", () => {
    const result = parse(pictureSchema, { mime: "image/png", label: "x", bytes: 1 });
    expect(result.ok).toBe(false);
  });
});

describe("messageSchema", () => {
  test("valid assistant message passes", () => {
    const msg: Message = {
      role: "assistant",
      content: "hello",
    };
    const result = parse(messageSchema, msg);
    expect(result.ok).toBe(true);
  });

  test("invalid role fails", () => {
    const result = parse(messageSchema, { role: "robot", content: "hi" });
    expect(result.ok).toBe(false);
  });
});

describe("goalTraceFactSchema", () => {
  test("valid verdict fact passes", () => {
    const entry = {
      kind: "verdict" as const,
      verdict: "done",
      detail: "all steps completed",
      at: "2025-01-01T00:00:00Z",
      after: 1234567890000,
    };
    const result = parse(goalTraceFactSchema, entry);
    expect(result.ok).toBe(true);
  });

  test("unknown kind fails", () => {
    const result = parse(goalTraceFactSchema, { kind: "unknown", text: "x" });
    expect(result.ok).toBe(false);
  });
});

describe("workflowSchema", () => {
  test("valid workflow passes", () => {
    const wf: Workflow = {
      steps: [{ type: "instruction", text: "do the thing" }],
    };
    const result = parse(workflowSchema, wf);
    expect(result.ok).toBe(true);
  });

  test("missing steps fails", () => {
    const result = parse(workflowSchema, {});
    expect(result.ok).toBe(false);
  });

  test("empty steps pass", () => {
    const result = parse(workflowSchema, { steps: [] });
    expect(result.ok).toBe(true);
  });

  test("tool step with args passes", () => {
    const wf: Workflow = {
      steps: [{ type: "tool", name: "read_file", args: { path: "x" }, exact: true }],
    };
    const result = parse(workflowSchema, wf);
    expect(result.ok).toBe(true);
  });

  test("tool step without args fails", () => {
    const result = parse(workflowSchema, {
      steps: [{ type: "tool", name: "x" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("mcpServerSpecSchema", () => {
  test("stdio server passes", () => {
    const spec = { command: "node", args: ["server.js"], env: { KEY: "val" } };
    const result = parse(mcpServerSpecSchema, spec);
    expect(result.ok).toBe(true);
  });

  test("url server passes", () => {
    const spec = { url: "https://example.com/mcp", headers: { auth: "token" } };
    const result = parse(mcpServerSpecSchema, spec);
    expect(result.ok).toBe(true);
  });

  test("neither command nor url fails", () => {
    const result = parse(mcpServerSpecSchema, {});
    expect(result.ok).toBe(false);
  });

  test("both command and url is handled by parseServer, not the schema", () => {
    const result = parse(mcpServerSpecSchema, { command: "x", url: "https://x.com" });
    expect(result.ok).toBe(true);
  });

  test("bad args type fails", () => {
    const result = parse(mcpServerSpecSchema, { command: "x", args: "notarray" });
    expect(result.ok).toBe(false);
  });
});

describe("auditEventSchema", () => {
  test("session_start event passes", () => {
    const event: AuditEvent = { kind: "session_start", session: "abc" };
    const result = parse(auditEventSchema, event);
    expect(result.ok).toBe(true);
  });

  test("turn_start event passes", () => {
    const event: AuditEvent = { kind: "turn_start", turn: "t1", text: "hello" };
    const result = parse(auditEventSchema, event);
    expect(result.ok).toBe(true);
  });

  test("unknown kind fails", () => {
    const result = parse(auditEventSchema, { kind: "nope" });
    expect(result.ok).toBe(false);
  });
});

describe("auditCallSchema", () => {
  test("valid call passes", () => {
    const call: AuditCall = {
      request: 1,
      purpose: "chat",
      model: "gpt-4",
      state: "done",
      ms: 1000,
    };
    const result = parse(auditCallSchema, call);
    expect(result.ok).toBe(true);
  });

  test("missing required field fails", () => {
    const result = parse(auditCallSchema, {
      purpose: "chat",
      model: "gpt-4",
      state: "done",
      ms: 100,
    });
    expect(result.ok).toBe(false);
  });
});

describe("toolCallArgsSchema", () => {
  test("valid args pass", () => {
    const result = parse(toolCallArgsSchema, {
      name: "read_file",
      arguments: { path: "x" },
    });
    expect(result.ok).toBe(true);
  });

  test("missing name fails", () => {
    const result = parse(toolCallArgsSchema, { arguments: {} });
    expect(result.ok).toBe(false);
  });

  test("non-object arguments fails", () => {
    const result = parse(toolCallArgsSchema, { name: "x", arguments: "str" });
    expect(result.ok).toBe(false);
  });
});

describe("validateSettingValue", () => {
  test("text value always passes", () => {
    expect(validateSettingValue("anything", "Test", "default")).toBeUndefined();
  });

  test("numeric value below min fails", () => {
    const problem = validateSettingValue("0", "Count", 5, 1);
    expect(problem).toBe("Count: needs a number of at least 1");
  });

  test("non-numeric value for numeric spec fails", () => {
    const problem = validateSettingValue("abc", "Count", 5);
    expect(problem).toBe("Count: needs a number of at least 0");
  });

  test("newline in value fails", () => {
    const problem = validateSettingValue("a\nb", "Multi", "default");
    expect(problem).toBe("Multi: must be one line");
  });
});

describe("parseProfileText", () => {
  test("parses frontmatter with tools", () => {
    const result = parseProfileText("---\ntools: a, b\n---\nBody\n");
    expect(result.tools).toEqual(["a", "b"]);
    expect(result.body).toBe("Body\n");
  });

  test("parses frontmatter with hooks", () => {
    const result = parseProfileText('---\nhooks: ["pre:cmd"]\n---\nBody\n');
    expect(result.hooks).toEqual(["pre:cmd"]);
  });

  test("no frontmatter returns body as-is", () => {
    const result = parseProfileText("Just text");
    expect(result.body).toBe("Just text");
    expect(result.tools).toBeUndefined();
  });

  test("keeps other meta lines", () => {
    const result = parseProfileText("---\nauthor: bob\ntools: x\n---\nBody\n");
    expect(result.meta).toContain("author: bob");
  });
});

describe("parseJson", () => {
  test("valid JSON + passing schema returns ok", () => {
    const result = parseJson(z.array(z.string()), '["a","b"]');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(["a", "b"]);
  });

  test("valid JSON + schema mismatch returns malformed", () => {
    const result = parseJson(z.array(z.string()), '[1,2,3]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("malformed");
  });

  test("invalid JSON returns malformed with truncated body", () => {
    const long = "not json at all, just a plain string without any structure";
    const result = parseJson(z.string(), long);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
      if (result.error.kind === "malformed")
        expect(result.error.body.startsWith("invalid JSON:")).toBe(true);
    }
  });
});
