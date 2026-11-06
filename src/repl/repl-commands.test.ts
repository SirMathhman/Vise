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
    disabledTools: [],
    saveDisabledTools: async () => ok(undefined),
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
