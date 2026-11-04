import { expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChatMessage } from "../core/messages.ts";
import { ok } from "../core/result.ts";
import { runRepl, type Reply } from "./repl.ts";

test("echoes each line until exit", async () => {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runRepl(Readable.from(["hello\n", "world\n", "/exit\n", "ignored\n"]), output);
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
  await runRepl(Readable.from(["hello\n/exit\nignored\n"]), output);
  expect(written).toContain("echo: hello\n");
  expect(written).not.toContain("echo: ignored");
});

test("sends earlier lines and replies with each new line", async () => {
  const seen: ChatMessage[][] = [];
  const reply = async function* (messages: ChatMessage[]) {
    seen.push(messages.map((message) => ({ ...message })));
    yield ok(`answer ${seen.length}`);
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await runRepl(Readable.from(["first\nsecond\n"]), output, reply);
  expect(seen[1]).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "second" },
  ]);
});

test("/context shows the prompt tokens of the last request out of the model's window", async () => {
  const reply: Reply = async function* (_messages, onUsage) {
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
  await runRepl(Readable.from(["hello\n", "/context\n"]), output, reply, async () => ok(1000));
  expect(written).toContain("context: 42 / 1000 tokens");
});

test("rejects an unknown command without sending it to the model", async () => {
  const seen: string[] = [];
  const reply: Reply = async function* (messages) {
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
  await runRepl(Readable.from(["/foo\n"]), output, reply);
  expect(seen).toEqual([]);
  expect(written).toContain("error: unknown command /foo");
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
  const result = await runRepl(Readable.from(["hello\n"]), output, reply);
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
  const result = await runRepl(input, output);
  expect(result.ok).toBe(true);
});

test("ends with an error when the output stream fails", async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error("pipe closed"));
    },
  });
  const result = await runRepl(Readable.from(["hello\n"]), output);
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
  const result = await runRepl(input, output);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toBe("input broke");
});
