import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { runRepl } from "./index.ts";
import type { ChatMessage } from "./src/openrouter.ts";

test("echoes each line until exit", async () => {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runRepl(Readable.from(["hello\n", "world\n", "exit\n", "ignored\n"]), output);
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
  await runRepl(Readable.from(["hello\nexit\nignored\n"]), output);
  expect(written).toContain("echo: hello\n");
  expect(written).not.toContain("echo: ignored");
});

test("sends earlier lines and replies with each new line", async () => {
  const seen: ChatMessage[][] = [];
  const reply = async function* (messages: ChatMessage[]) {
    seen.push(messages.map((message) => ({ ...message })));
    yield `answer ${seen.length}`;
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
