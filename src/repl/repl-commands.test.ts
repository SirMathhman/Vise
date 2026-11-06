import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { ChatMessage } from "../core/messages.ts";
import { err, ok } from "../core/result.ts";
import { echoReply, runRepl, type Reply, type ReplPorts } from "./repl.ts";

// The ports a test session uses. Each test overrides only the ports it needs.
function ports(overrides: Partial<ReplPorts> = {}): ReplPorts {
  return {
    reply: echoReply,
    contextWindow: async () => err(new Error("no context window is configured")),
    tools: async () => "no tools are available",
    notes: async () => "notes are not available",
    profile: async () => err(new Error("no profiles are available")),
    profileTools: async () => ok(undefined),
    profileHooks: async () => ok([]),
    hooks: async () => ok(""),
    models: { current: () => "m", list: async () => ok([]), select: async (name: string) => ok(name) },
    disabledTools: [],
    saveDisabledTools: async () => ok(undefined),
    sessions: { save: async () => ok(undefined), load: async () => err(new Error("none")), list: async () => ok([]) },
    ...overrides,
  };
}

test("a switched profile is sent once, with the next message, and history already sent is kept", async () => {
  const seen: ChatMessage[][] = [];
  const reply = async function* (messages: ChatMessage[]) {
    seen.push(messages.map((message) => ({ ...message })));
    yield ok(`answer ${seen.length}`);
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  const profile = async (name: string) => (name === "terse" ? ok("BE TERSE") : err(new Error("no such profile")));
  await runRepl(
    Readable.from(["/profile terse\n", "/profile\n", "hello\n", "again\n"]),
    output,
    ports({ reply, profile }),
  );
  expect(written).toContain("profile: terse\n");
  expect(seen[0]).toEqual([{ role: "user", content: "BE TERSE\n\nhello" }]);
  expect(seen[1]).toEqual([
    { role: "user", content: "BE TERSE\n\nhello" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "again" },
  ]);
});

test("a compaction sends the active profile again with the next message", async () => {
  const seen: string[][] = [];
  const reply: Reply = async function* (messages) {
    seen.push(messages.map((message) => message.content));
    yield ok(messages.at(-1)?.content === "Summarize this convo" ? "SUM" : "ok");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runRepl(
    Readable.from(["/profile terse\n", "hello\n", "/compact\n", "next\n"]),
    output,
    ports({ reply, profile: async () => ok("BE TERSE") }),
  );
  expect(seen.at(-1)?.at(-1)).toBe("BE TERSE\n\nnext");
});

test("/profile default clears the pending profile before the next message", async () => {
  const seen: string[] = [];
  const reply: Reply = async function* (messages) {
    seen.push(messages.at(-1)?.content ?? "");
    yield ok("ok");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runRepl(
    Readable.from(["/profile terse\n", "/profile default\n", "hello\n"]),
    output,
    ports({ reply, profile: async () => ok("BE TERSE") }),
  );
  expect(seen).toEqual(["hello"]);
});

test("a failed turn keeps the pending profile for the next attempt", async () => {
  const seen: string[] = [];
  let calls = 0;
  const reply: Reply = async function* (messages) {
    calls += 1;
    seen.push(messages.at(-1)?.content ?? "");
    if (calls === 1) {
      yield err(new Error("cut off"));
      return;
    }
    yield ok("ok");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runRepl(
    Readable.from(["/profile terse\n", "a\n", "b\n"]),
    output,
    ports({ reply, profile: async () => ok("BE TERSE") }),
  );
  expect(seen).toEqual(["BE TERSE\n\na", "BE TERSE\n\nb"]);
});

test("a switched-off tool is left out of the request and out of the tools the runner is given", async () => {
  const offered: string[][] = [];
  const runnerGiven: string[][] = [];
  const reply: Reply = async function* (messages, _onUsage, onToolCall, tools) {
    offered.push(tools);
    if (messages.at(-1)?.role === "user") {
      onToolCall({ id: "e1", name: "edit_file", arguments: '{"path":"f.txt","previous":"a","replacement":"b"}' });
      return;
    }
    yield ok("done");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runRepl(
    // /exit is queued after the message, so the tool call still runs: a call is skipped once the input has ended.
    Readable.from(["/tools disable edit_file\n", "go\n", "/exit\n"]),
    output,
    ports({
      reply,
      tools: async (_call, _approve, enabled) => {
        runnerGiven.push(enabled);
        return "not run by this fake";
      },
    }),
  );
  expect(offered[0]).not.toContain("edit_file");
  expect(offered[0]).toContain("list_files");
  expect(runnerGiven[0]).not.toContain("edit_file");
});

test("/tools disable saves the switched-off tools", async () => {
  const saved: string[][] = [];
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runRepl(
    Readable.from(["/tools disable kill_command\n", "/tools enable kill_command\n", "/tools disable run_powershell\n"]),
    output,
    ports({
      saveDisabledTools: async (names) => {
        saved.push(names);
        return ok(undefined);
      },
    }),
  );
  expect(saved).toEqual([["kill_command"], [], ["run_powershell"]]);
});

test("/save writes the conversation, and /load in a new session brings it back for the next request", async () => {
  const files = new Map<string, string>();
  const sessions = {
    save: async (name: string, text: string) => {
      files.set(name, text);
      return ok(undefined);
    },
    load: async (name: string) => {
      const text = files.get(name);
      return text === undefined ? err(new Error("no saved session")) : ok(text);
    },
    list: async () => ok([...files.keys()]),
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const first: Reply = async function* () {
    yield ok("ok");
  };
  await runRepl(Readable.from(["hello\n", "/save work\n"]), output, ports({ reply: first, sessions }));
  const seen: string[][] = [];
  const reply: Reply = async function* (messages) {
    seen.push(messages.map((message) => message.content));
    yield ok("ok");
  };
  await runRepl(Readable.from(["/load work\n", "again\n"]), output, ports({ reply, sessions }));
  expect(seen[0]).toEqual(["hello", "ok", "again"]);
});

test("a call skipped because /exit ended the session is reported as not run", async () => {
  const reply: Reply = async function* (messages, _onUsage, onToolCall) {
    if (messages.at(-1)?.role === "user") {
      onToolCall({ id: "e1", name: "edit_file", arguments: '{"path":"f.txt","previous":"a","replacement":"b"}' });
      onToolCall({ id: "l1", name: "list_files", arguments: '{"path":"."}' });
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
  await runRepl(
    Readable.from(["go\n", "/exit\n"]),
    output,
    ports({
      reply,
      tools: async (_call, approve) => {
        if (!(await approve("edit f.txt"))) return "the user declined this change";
        return "edited f.txt";
      },
    }),
  );
  expect(written).toContain("tool: list_files . depth 2 did not run: the session ended");
});

test("a profile's whitelist limits the tools offered to the model from the next request", async () => {
  const offered: string[][] = [];
  const reply: Reply = async function* (messages, _onUsage, _onToolCall, tools) {
    offered.push(tools);
    if (messages.length > 0) yield ok("ok");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runRepl(
    Readable.from(["/profile reader\n", "go\n"]),
    output,
    ports({
      reply,
      profile: async () => ok("Read only."),
      profileTools: async () => ok(["list_files"]),
    }),
  );
  expect(offered[0]).toEqual(["list_files"]);
});

test("a turn-start hook's output goes in front of the message, and a failing one stops the turn", async () => {
  const seen: string[] = [];
  const reply: Reply = async function* (messages) {
    seen.push(messages.at(-1)?.content ?? "");
    yield ok("ok");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runRepl(
    Readable.from(["hello\n"]),
    output,
    ports({
      reply,
      hooks: async (point) => (point === "turnStart" ? ok("HOOK") : ok("")),
    }),
  );
  expect(seen).toEqual(["HOOK\n\nhello"]);
  seen.length = 0;
  let refused = "";
  const errorOutput = new Writable({
    write(chunk, _encoding, done) {
      refused += chunk.toString();
      done();
    },
  });
  await runRepl(
    Readable.from(["hello\n"]),
    errorOutput,
    ports({ reply, hooks: async (point) => (point === "turnStart" ? err(new Error("boom")) : ok("")) }),
  );
  expect(seen).toEqual([]);
  expect(refused).toContain("error: turn-start hook failed: boom");
});

test("a session-start hook that fails refuses the session", async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const result = await runRepl(
    Readable.from(["hello\n"]),
    output,
    ports({ hooks: async (point) => (point === "sessionStart" ? err(new Error("no start")) : ok("")) }),
  );
  expect(result.ok).toBe(false);
});

test("a turn-start hook's output is shown on the terminal as well as sent", async () => {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runRepl(
    Readable.from(["hello\n"]),
    output,
    ports({ hooks: async (point) => (point === "turnStart" ? ok("HOOK LINE") : ok("")) }),
  );
  expect(written).toContain("HOOK LINE");
});

test("the active profile's hooks are passed to the hook runner at their point", async () => {
  const seen: string[][] = [];
  await runRepl(
    Readable.from(["/profile tester\n", "hi\n", "/exit\n"]),
    new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    ports({
      profile: async () => ok("Body."),
      profileHooks: async () => ok([{ point: "turnEnd", command: "npm test" }]),
      hooks: async (point, profile) => {
        if (point === "turnEnd") seen.push(profile ?? []);
        return ok("");
      },
    }),
  );
  expect(seen).toEqual([["npm test"]]);
});

test("/thinking sets the effort for later requests, and the thinking count is shown", async () => {
  const seen: (string | undefined)[] = [];
  const reply: Reply = async function* (_messages, _onUsage, _onToolCall, _tools, reasoning, onThinking) {
    seen.push(reasoning);
    onThinking(5);
    yield ok("answer");
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runRepl(Readable.from(["/thinking low\n", "/thinking\n", "hi\n"]), output, ports({ reply }));
  expect(seen).toEqual(["low"]);
  expect(written).toContain("thinking: low");
  expect(written).toContain("thinking: ~5 tokens");
});

test("/model lists the models, marking the one in use, and /model <name> switches to a listed one", async () => {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  const models = {
    current: () => "a/one",
    list: async () =>
      ok([
        { id: "b/two", contextLength: 2000 },
        { id: "a/one", contextLength: 1000 },
        { id: "a/three", contextLength: 3000 },
      ]),
    select: async (name: string) => (name === "b/two" ? ok(name) : err(new Error("no such model"))),
  };
  await runRepl(
    Readable.from(["/model\n", "/model search A/\n", "/model b/two\n", "/model zzz\n"]),
    output,
    ports({ models }),
  );
  expect(written).toContain("model: a/one\nusage:");
  expect(written).toContain("* a/one  1000 tokens\n  a/three  3000 tokens\n");
  expect(written).not.toContain("b/two  2000 tokens");
  expect(written).toContain("model: b/two");
  expect(written).toContain("error: no such model");
});
