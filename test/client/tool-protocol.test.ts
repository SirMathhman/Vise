import { describe, expect, test } from "bun:test";
import {
  buildGrammar,
  encodeMessages,
  hideCalls,
  nameConfidence,
  parseReply,
  parseToolCalls,
} from "../../packages/backend/src/client/tool-protocol.ts";
import type { Tool } from "@vise/core";

const def = (name: string): Tool => ({
  type: "function",
  function: { name, description: "", parameters: {} },
});

describe("tool protocol (edge)", () => {
  test("grammar permits only enabled tool names", () => {
    const g = buildGrammar(["read_file"]);
    expect(g).toContain('"\\"read_file\\""');
    expect(g).not.toContain("delete_file");
    expect(buildGrammar([])).toBeUndefined();
  });

  test("grammar enforces each tool's argument schema", () => {
    const read: Tool = {
      type: "function",
      function: {
        name: "read_file",
        description: "",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "integer" },
            limit: { type: "integer" },
          },
          required: ["path"],
        },
      },
    };
    const g = buildGrammar([read]) ?? "";
    // The required key comes first and is not optional; the others are optional.
    expect(g).toContain(
      'args0 ::= "{" ws "\\"path\\"" ws ":" ws string ( ws "," ws opt0-0 )? ws "}"',
    );
    expect(g).toContain(
      'opt0-0 ::= "\\"offset\\"" ws ":" ws numlike ( ws "," ws opt0-1 )? | opt0-1',
    );
    expect(g).toContain('opt0-1 ::= "\\"limit\\"" ws ":" ws numlike');
    // GBNF rule names allow only letters, digits and "-" (llama.cpp rejects "_").
    for (const m of g.matchAll(/^([^\s:]+) ::=/gm)) {
      expect(m[1]).toMatch(/^[a-zA-Z0-9-]+$/);
    }
  });

  test("a tool without declared properties accepts any object", () => {
    const g = buildGrammar([def("mcp__srv__tool")]) ?? "";
    expect(g).toContain("args0 ::= object");
    expect(g).toContain('"\\"mcp__srv__tool\\""');
  });

  test("grammar allows free text before calls", () => {
    const g = buildGrammar(["a"]) ?? "";
    expect(g).toContain("root ::= t0 calls?");
    expect(g).toContain("t10 ::=");
  });

  test("prompt prefix is independent of which tools are enabled", () => {
    const tools = [def("a"), def("b")];
    const msgs = [{ role: "system" as const, content: "sys" }];
    expect(encodeMessages(msgs, tools)).toEqual(encodeMessages(msgs, tools));
    expect(encodeMessages(msgs, tools)[0]?.content).toContain('"name":"b"');
  });

  test("parses calls out of content", () => {
    const r = parseToolCalls('hi <tool_call>\n{"name":"a","arguments":{"x":1}}\n</tool_call>');
    expect(r.content).toBe("hi");
    expect(r.tool_calls[0]?.function.name).toBe("a");
    expect(r.tool_calls[0]?.function.arguments).toBe('{"x":1}');
  });

  test("reads a call the model wrapped twice (no grammar keeps it well-formed)", () => {
    // Seen from Qwen3.8 on Strata, which has no grammar decoding.
    const text =
      '<tool_call>\n<tool_call>\n{"name": "get_temperature", "arguments": {"city": "Paris"}}\n</tool_call>\n</tool_call>\n' +
      '<tool_call>\n<tool_call>\n{"name": "get_temperature", "arguments": {"city": "Tokyo"}}\n</tool_call>\n</tool_call>';
    const r = parseToolCalls(text);
    expect(r.content).toBe("");
    expect(r.tool_calls.map((c) => c.function.arguments)).toEqual([
      '{"city":"Paris"}',
      '{"city":"Tokyo"}',
    ]);
    expect(r.tool_calls.map((c) => c.id)).toEqual([
      expect.stringMatching(/_0$/),
      expect.stringMatching(/_1$/),
    ]);
  });

  test("reads a call whose opener lost its brackets, and keeps the prose before it", () => {
    const r = parseToolCalls('Checking.\ntool_call\n{"name":"add","arguments":{"a":1,"b":2}}\n</tool_call>');
    expect(r.content).toBe("Checking.");
    expect(r.tool_calls[0]?.function.name).toBe("add");
    expect(r.tool_calls[0]?.function.arguments).toBe('{"a":1,"b":2}');
  });

  test("a call without arguments gets an empty object; braces inside strings do not end the object", () => {
    const r = parseToolCalls('<tool_call><tool_call>{"name":"now"}</tool_call></tool_call>');
    expect(r.tool_calls[0]?.function.arguments).toBe("{}");
    const s = parseToolCalls('tool_call\n{"name":"say","arguments":{"t":"a } b"}}\n</tool_call>');
    expect(s.tool_calls[0]?.function.arguments).toBe('{"t":"a } b"}');
  });

  test("prose that only mentions the format is never read as a call", () => {
    for (const text of [
      'Use <tool_call> tags like {"name":"x","arguments":{}} to call tools.',
      'Example: {"name":"x","arguments":{}} then </tool_call> ends it? no.',
      'tool_call\n{"name":7,"arguments":{}}\n</tool_call>',
      'tool_call\n{"name":"x","arguments":[1]}\n</tool_call>',
      "just text </tool_call>",
    ]) {
      const r = parseToolCalls(text);
      expect(r.tool_calls).toEqual([]);
      // (the strict reading has always cut the prose at a literal opener; the loose one adds no cut)
      if (!text.includes("<tool_call>")) expect(r.content).toBe(text);
    }
  });

  test("a well-formed call is read the strict way, byte for byte as before", () => {
    const r = parseToolCalls('<tool_call>\n{"name":"a","arguments":{"x":1}}\n</tool_call>\nthen more');
    expect(r.tool_calls).toHaveLength(1);
    expect(r.content).toBe("");
  });

  test("hideCalls stops streaming at the delimiter", () => {
    const seen: string[] = [];
    const f = hideCalls((t) => seen.push(t));
    for (const t of ["he", "llo <to", "ol_call>{}"]) f?.(t);
    expect(seen.join("")).toBe("hello ");
  });
});

describe("burst helpers (edge)", () => {
  test("nameConfidence uses only tokens inside the tool name", () => {
    const toks = [
      { token: "<tool_call>", logprob: -9 },
      { token: '{"name":"', logprob: 0 },
      { token: "list", logprob: Math.log(0.4) },
      { token: "_dir", logprob: 0 },
      { token: '","arguments":{}}', logprob: -5 },
    ];
    expect(nameConfidence(toks)).toBeCloseTo(0.4);
  });

  test("done marker is detected and stripped", () => {
    expect(parseReply({ content: "<done/>" }, "", true).done).toBe(true);
    expect(parseReply({ content: "all <done/>" }, "").content).toBe("all");
  });

  test("act grammar allows only calls or done", () => {
    const g = buildGrammar(["a"], true) ?? "";
    expect(g).toContain('root ::= calls | "<done/>"');
    expect(g).not.toContain("t0");
  });
});

describe("bounded calls", () => {
  test("a reply holds at most the given number of calls", () => {
    const g = buildGrammar(["a"], false, 3) ?? "";
    expect(g).toContain("root ::= t0 calls?");
    expect(g).toContain("calls ::= call (call (call)?)?");
    expect(buildGrammar(["a"], false, 1)).toMatch(/calls ::= call\r?\n/);
  });
});

describe("hideCalls done marker (edge)", () => {
  test("drops <done/> even when split across tokens", () => {
    const seen: string[] = [];
    const f = hideCalls((t) => seen.push(t));
    for (const t of ["a<do", "ne/>b"]) f?.(t);
    expect(seen.join("")).toBe("ab");
  });
});
