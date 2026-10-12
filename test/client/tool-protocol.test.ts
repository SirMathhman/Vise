import { describe, expect, test } from "bun:test";
import {
  buildGrammar,
  encodeMessages,
  hideCalls,
  nameConfidence,
  parseReply,
  parseToolCalls,
} from "../../src/client/tool-protocol.ts";
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
    expect(g).toContain('args0 ::= "{" ws "\\"path\\"" ws ":" ws string ( ws "," ws opt0-0 )? ws "}"');
    expect(g).toContain('opt0-0 ::= "\\"offset\\"" ws ":" ws numlike ( ws "," ws opt0-1 )? | opt0-1');
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
    expect(g).toContain("root ::= t0 call*");
    expect(g).toContain("t10 ::=");
  });

  test("prompt prefix is independent of which tools are enabled", () => {
    const tools = [def("a"), def("b")];
    const msgs = [{ role: "system" as const, content: "sys" }];
    expect(encodeMessages(msgs, tools)).toEqual(encodeMessages(msgs, tools));
    expect(encodeMessages(msgs, tools)[0]?.content).toContain('"name":"b"');
  });

  test("parses calls out of content", () => {
    const r = parseToolCalls(
      'hi <tool_call>\n{"name":"a","arguments":{"x":1}}\n</tool_call>',
    );
    expect(r.content).toBe("hi");
    expect(r.tool_calls[0]?.function.name).toBe("a");
    expect(r.tool_calls[0]?.function.arguments).toBe('{"x":1}');
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
    expect(g).toContain('root ::= call+ | "<done/>"');
    expect(g).not.toContain("t0");
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
