import { expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import { type ChatMessage, type Reply, type ReplyRequest, err, ok } from "../core/messages.ts";
import { echoReply, runWithPorts } from "./session-helper.ts";
import type { SessionPorts } from "../backend/ports.ts";

// The ports a test session uses. Each test overrides only the ports it needs.
function ports(overrides: Partial<SessionPorts> = {}): SessionPorts {
  return {
    reply: echoReply,
    contextWindow: async () =>
      err(new Error("no context window is configured")),
    tools: async () => "no tools are available",
    notes: async () => "notes are not available",
    profile: async () => err(new Error("no profiles are available")),
    profileTools: async () => ok(undefined),
    profileHooks: async () => ok([]),
    hooks: async () => ok(""),
    models: {
      current: () => "m",
      list: async () => ok([]),
      select: async (name: string) => ok(name),
    },
    disabledTools: [],
    saveDisabledTools: async () => ok(undefined),
    sessions: {
      save: async () => ok(undefined),
      load: async () => err(new Error("none")),
      list: async () => ok([]),
    },
    ...overrides,
  };
}

test("echoes each line until exit", async () => {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runWithPorts(
    Readable.from(["hello\n", "world\n", "/exit\n", "ignored\n"]),
    output,
    ports(),
  );
  expect(written).toContain("echo: hello\n");
  expect(written).toContain("echo: world\n");
  expect(written).not.toContain("echo: ignored");
});

test("stops at exit even when later lines arrive in the same chunk", async () => {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runWithPorts(Readable.from(["hello\n/exit\nignored\n"]), output, ports());
  expect(written).toContain("echo: hello\n");
  expect(written).not.toContain("echo: ignored");
});

test("sends earlier lines and replies with each new line", async () => {
  const seen: ChatMessage[][] = [];
  const reply = async function* ({ messages }: ReplyRequest) {
    seen.push(messages.map((message) => ({ ...message })));
    yield ok(`answer ${seen.length}`);
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runWithPorts(Readable.from(["first\nsecond\n"]), output, ports({ reply }));
  expect(seen[1]).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "second" },
  ]);
});

test("puts the instructions in front of the first message only", async () => {
  const seen: ChatMessage[][] = [];
  const reply = async function* ({ messages }: ReplyRequest) {
    seen.push(messages.map((message) => ({ ...message })));
    yield ok(`answer ${seen.length}`);
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runWithPorts(
    Readable.from(["first\nsecond\n"]),
    output,
    ports({ reply, instructions: "RULES" }),
  );
  expect(seen[0]).toEqual([{ role: "user", content: "RULES\n\nfirst" }]);
  expect(seen[1]).toEqual([
    { role: "user", content: "RULES\n\nfirst" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "second" },
  ]);
});

test("sends a /note line to the note runner, prints its result, and keeps it out of the model", async () => {
  const seen: string[][] = [];
  const modelSaw: string[] = [];
  const reply: Reply = async function* ({ messages }) {
    modelSaw.push(messages.at(-1)?.content ?? "");
    yield ok("ok");
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  const notes = async (words: string[]) => {
    seen.push(words);
    return "work/plan";
  };
  await runWithPorts(
    Readable.from(["/note list work\n"]),
    output,
    ports({ reply, notes }),
  );
  expect(seen).toEqual([["list", "work"]]);
  expect(written).toContain("work/plan\n");
  expect(modelSaw).toEqual([]);
});

test("/context shows the prompt tokens of the last request out of the model's window", async () => {
  const reply: Reply = async function* ({ onUsage }) {
    onUsage({ promptTokens: 42 });
    yield ok("hi");
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runWithPorts(
    Readable.from(["hello\n", "/context\n"]),
    output,
    ports({ reply, contextWindow: async () => ok(1000) }),
  );
  expect(written).toContain("context: 42 / 1000 tokens");
});

test("rejects an unknown command without sending it to the model", async () => {
  const seen: string[] = [];
  const reply: Reply = async function* ({ messages }) {
    seen.push(messages.at(-1)?.content ?? "");
    yield ok("ok");
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runWithPorts(Readable.from(["/foo\n"]), output, ports({ reply }));
  expect(seen).toEqual([]);
  expect(written).toContain("error: unknown command /foo");
});

test("/compact replaces the history with a summary and the last six messages", async () => {
  const seen: string[][] = [];
  const reply: Reply = async function* ({ messages }) {
    seen.push(messages.map((message) => message.content));
    const last = messages.at(-1)?.content ?? "";
    yield ok(last === "Summarize this convo" ? "SUM" : `r:${last}`);
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const lines = ["1", "2", "3", "4", "5", "6", "7", "/compact", "next"];
  await runWithPorts(
    Readable.from(lines.map((line) => `${line}\n`)),
    output,
    ports({ reply }),
  );
  expect(seen.at(-1)).toEqual([
    "SUM\n\n5",
    "r:5",
    "6",
    "r:6",
    "7",
    "r:7",
    "next",
  ]);
});

test("compacts before a message once the last prompt fills 80% of the window", async () => {
  const seen: string[][] = [];
  const reply: Reply = async function* ({ messages, onUsage }) {
    seen.push(messages.map((message) => message.content));
    const last = messages.at(-1)?.content ?? "";
    if (last === "Summarize this convo") {
      yield ok("SUM");
      return;
    }
    onUsage({ promptTokens: 90 });
    yield ok(`r:${last}`);
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runWithPorts(
    Readable.from(["a\n", "b\n"]),
    output,
    ports({ reply, contextWindow: async () => ok(100) }),
  );
  expect(seen.at(-1)).toEqual(["SUM\n\na", "r:a", "b"]);
});

test("a failed reply does not record its prompt size", async () => {
  const seen: string[] = [];
  const reply: Reply = async function* ({ messages, onUsage }) {
    const last = messages.at(-1)?.content ?? "";
    seen.push(last);
    if (last === "a") {
      onUsage({ promptTokens: 90 });
      yield err(new Error("cut off"));
      return;
    }
    yield ok("fine");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runWithPorts(
    Readable.from(["a\n", "b\n"]),
    output,
    ports({ reply, contextWindow: async () => ok(100) }),
  );
  expect(seen).toEqual(["a", "b"]);
});

test("/context after a compaction says the size is unknown", async () => {
  const reply: Reply = async function* ({ messages }) {
    yield ok(
      messages.at(-1)?.content === "Summarize this convo" ? "SUM" : "ok",
    );
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runWithPorts(
    Readable.from(["a\n", "/compact\n", "/context\n"]),
    output,
    ports({ reply, contextWindow: async () => ok(100) }),
  );
  expect(written).toContain("context: size unknown since the last compaction");
});

test("reports a reply that throws as an error and keeps the session going", async () => {
  const reply: Reply = async function* () {
    await Promise.reject(new Error("boom"));
    yield ok("never");
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  const result = await runWithPorts(
    Readable.from(["hello\n"]),
    output,
    ports({ reply }),
  );
  expect(written).toContain("error: boom");
  expect(result.ok).toBe(true);
});

test("ends on /exit even while the input stream stays open", async () => {
  const input = new PassThrough();
  input.write("/exit\n");
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const result = await runWithPorts(input, output, ports());
  expect(result.ok).toBe(true);
});

test("runs a tool the model asks for and sends its result back", async () => {
  const seen: string[] = [];
  const reply: Reply = async function* ({ messages, onToolCall }) {
    const last = messages.at(-1);
    seen.push(
      messages
        .map((message) => `${message.role}:${message.content}`)
        .join(" | "),
    );
    if (last?.role === "user") {
      onToolCall({ id: "c1", name: "list_files", arguments: '{"path":"."}' });
      return;
    }
    yield ok("done");
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runWithPorts(
    Readable.from(["list\n", "/exit\n"]),
    output,
    ports({ reply, tools: async () => "a.txt" }),
  );
  expect(written).toContain("tool: list_files . depth 2");
  expect(seen.at(-1)).toBe("user:list | assistant: | tool:a.txt");
});

test("an edit is run only when the user answers y", async () => {
  const reply: Reply = async function* ({ messages, onToolCall }) {
    if (messages.at(-1)?.role === "user") {
      onToolCall({
        id: "e1",
        name: "edit_file",
        arguments: '{"path":"f.txt","previous":"a","replacement":"b"}',
      });
      return;
    }
    yield ok("done");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  // The answer is typed after the preview is shown, as a user would type it.
  const answerAfterPreview = async (answer: string): Promise<string[]> => {
    const input = new PassThrough();
    input.write("go\n");
    const ran: string[] = [];
    await runWithPorts(
      input,
      output,
      ports({
        reply,
        tools: async (call, approve) => {
          const pending = approve("edit f.txt");
          input.write(`${answer}\n`);
          const yes = await pending;
          input.end();
          if (!yes) return "the user declined this change";
          ran.push(call.name);
          return "edited f.txt";
        },
      }),
    );
    return ran;
  };
  expect(await answerAfterPreview("n")).toEqual([]);
  expect(await answerAfterPreview("y")).toEqual(["edit_file"]);
});

test("/exit at an approval ends the session without another model request", async () => {
  let requests = 0;
  const reply: Reply = async function* ({ messages, onToolCall }) {
    requests += 1;
    if (messages.at(-1)?.role === "user") {
      onToolCall({
        id: "e1",
        name: "edit_file",
        arguments: '{"path":"f.txt","previous":"a","replacement":"b"}',
      });
      return;
    }
    yield ok("done");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runWithPorts(
    Readable.from(["go\n", "/exit\n", "hello\n"]),
    output,
    ports({
      reply,
      tools: async (_call, approve) => {
        if (!(await approve("edit f.txt")))
          return "the user declined this change";
        return "edited f.txt";
      },
    }),
  );
  expect(requests).toBe(1);
});

test("sends no request after a tool call when the input has ended", async () => {
  let requests = 0;
  const reply: Reply = async function* ({ onToolCall }) {
    requests += 1;
    onToolCall({ id: "l1", name: "list_files", arguments: '{"path":"."}' });
    yield ok("");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runWithPorts(
    Readable.from(["go\n"]),
    output,
    ports({ reply, tools: async () => "a.txt" }),
  );
  expect(requests).toBe(1);
});

test("does not run a tool when the input has ended", async () => {
  const reply: Reply = async function* ({ onToolCall }) {
    onToolCall({ id: "l1", name: "list_files", arguments: '{"path":"."}' });
    yield ok("");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  let ran = 0;
  await runWithPorts(
    Readable.from(["go\n"]),
    output,
    ports({
      reply,
      tools: async () => {
        ran += 1;
        return "a.txt";
      },
    }),
  );
  expect(ran).toBe(0);
});

test("stops at a stream failure even when more input is queued", async () => {
  const input = new PassThrough();
  input.write("a\nb\n");
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  let requests = 0;
  const reply: Reply = async function* () {
    requests += 1;
    input.emit("error", new Error("input broke"));
    yield ok("x");
  };
  const result = await runWithPorts(input, output, ports({ reply }));
  expect(requests).toBe(1);
  expect(result.ok).toBe(false);
});

test("ends with an error when the output stream fails", async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error("pipe closed"));
    },
  });
  const result = await runWithPorts(Readable.from(["hello\n"]), output, ports());
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toBe("pipe closed");
});

test("ends with an error when the input stream fails", async () => {
  const input = new Readable({
    read() {
      this.destroy(new Error("input broke"));
    },
  });
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const result = await runWithPorts(input, output, ports());
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toBe("input broke");
});
