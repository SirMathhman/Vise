import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { type Reply, ok } from "../core/messages.ts";
import { ports, runWithPorts } from "./session-helper.ts";

// A model that asks for the same list_files call on every round, up to a cap so a broken guard cannot loop
// forever. It returns how many rounds it was asked for, and what the session wrote.
interface Repeating {
  rounds: number;
  written: string;
}

async function runRepeating(unattended: boolean): Promise<Repeating> {
  let rounds = 0;
  const reply: Reply = async function* ({ onToolCall }) {
    rounds += 1;
    if (rounds <= 10) onToolCall({ id: `c${rounds}`, name: "list_files", arguments: '{"path":"."}' });
    yield ok("");
  };
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  await runWithPorts(
    Readable.from(["go\n", "/exit\n"]),
    output,
    ports({ reply, tools: async () => "error: boom", unattended }),
  );
  return { rounds, written };
}

test("an unattended run ends a message after the same call fails three times in a row", async () => {
  const { rounds, written } = await runRepeating(true);
  expect(rounds).toBe(3);
  expect(written).toContain("list_files failed 3 times in a row with the same arguments");
});

test("an attended run does not stop at repeated failures", async () => {
  const { rounds, written } = await runRepeating(false);
  expect(rounds).toBe(11);
  expect(written).not.toContain("failed 3 times in a row");
});
