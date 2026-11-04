import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { runRepl } from "./index.ts";

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
