import { describe, expect, test } from "bun:test";
import { createTranscript } from "../web/src/transcript.ts";

function makeLog() {
  const children: { className: string; textContent: string | null }[] = [];
  return {
    children,
    log: {
      appendChild(element: { className: string; textContent: string | null }) {
        children.push(element);
      },
      set scrollTop(_value: number) {},
      get scrollHeight() {
        return children.length;
      },
      set textContent(value: string | null) {
        if (value === "") children.length = 0;
      },
    } as unknown as HTMLElement,
  };
}

function installDocumentStub() {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      className: "",
      textContent: "",
    }),
  } as unknown as Document;
  return () => {
    globalThis.document = originalDocument;
  };
}

describe("web transcript ordering", () => {
  test("flushes streamed assistant text before tool calls", () => {
    const restoreDocument = installDocumentStub();
    try {
      const { log, children } = makeLog();
      const transcript = createTranscript(log);
      transcript.appendAssistantToken("Before tool call.");
      transcript.appendToolCall("self");
      transcript.appendAssistantToken("After tool call.");
      transcript.flushAssistant();

      expect(
        children.map((line) => [line.className, line.textContent]),
      ).toEqual([
        ["line assistant", "Before tool call."],
        ["line tool", "tool: self"],
        ["line assistant", "After tool call."],
      ]);
    } finally {
      restoreDocument();
    }
  });

  test("flushes assistant text before thinking and preserves alternating events", () => {
    const restoreDocument = installDocumentStub();
    try {
      const { log, children } = makeLog();
      const transcript = createTranscript(log);
      transcript.appendAssistantToken("First.");
      transcript.appendThinkingToken("Reasoning.");
      transcript.appendAssistantToken("Second.");
      transcript.appendToolCall("read_file", 1);
      transcript.appendThinkingToken("More reasoning.");
      transcript.flushAssistant();

      expect(
        children.map((line) => [line.className, line.textContent]),
      ).toEqual([
        ["line assistant", "First."],
        ["line thinking", "Reasoning."],
        ["line assistant", "Second."],
        ["line tool", "tool: read_file (subagent)"],
        ["line thinking", "More reasoning."],
      ]);
    } finally {
      restoreDocument();
    }
  });
});

describe("web transcript burst marking", () => {
  test("announces a burst once and marks its tool calls", () => {
    const restoreDocument = installDocumentStub();
    try {
      const { log, children } = makeLog();
      const transcript = createTranscript(log);
      transcript.appendToolCall("a");
      transcript.setBurst(true);
      transcript.setBurst(true);
      transcript.appendToolCall("b");
      transcript.setBurst(false);
      transcript.appendToolCall("c");

      expect(children.map((line) => line.className)).toEqual([
        "line tool",
        "line burst",
        "line tool burst",
        "line tool",
      ]);
    } finally {
      restoreDocument();
    }
  });
});
