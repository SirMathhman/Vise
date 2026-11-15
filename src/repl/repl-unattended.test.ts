import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { type Reply, ok } from "../core/messages.ts";
import { ports, runWithPorts } from "./session-helper.ts";

// How one run of a model that keeps asking for tools is set up.
interface LoopSetup {
  unattended: boolean;
  maxRounds?: number;
  // Whether the model alternates between two tools, or asks for list_files every round.
  alternate: boolean;
  // What every tool call returns.
  toolResult: string;
}

interface LoopOutcome {
  rounds: number;
  written: string;
}

// Runs a model that asks for tools every round, up to a cap of its own so a broken guard cannot loop forever.
async function runLoop(setup: LoopSetup): Promise<LoopOutcome> {
  let rounds = 0;
  const reply: Reply = async function* ({ onToolCall }) {
    rounds += 1;
    if (rounds <= 10) {
      const name = setup.alternate && rounds % 2 === 0 ? "read_file" : "list_files";
      const arguments_ = name === "read_file" ? '{"path":"a.txt"}' : '{"path":"."}';
      onToolCall({ id: `c${rounds}`, name, arguments: arguments_ });
    }
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
    ports({
      reply,
      tools: async () => setup.toolResult,
      unattended: setup.unattended,
      maxRounds: setup.maxRounds,
    }),
  );
  return { rounds, written };
}

test("an unattended run ends a message after three rounds in a row in which every call fails", async () => {
  const { rounds, written } = await runLoop({ unattended: true, alternate: false, toolResult: "error: boom" });
  expect(rounds).toBe(3);
  expect(written).toContain("the last 3 rounds each had only failing calls");
});

test("an unattended run ends a message on alternating failing calls too", async () => {
  const { rounds } = await runLoop({ unattended: true, alternate: true, toolResult: "error: boom" });
  expect(rounds).toBe(3);
});

test("an attended run does not stop at failing rounds", async () => {
  const { rounds, written } = await runLoop({ unattended: false, alternate: true, toolResult: "error: boom" });
  expect(rounds).toBe(11);
  expect(written).not.toContain("rounds each had only failing calls");
});

test("an unattended run with a round cap ends a message at the cap, even when its calls succeed", async () => {
  const { rounds, written } = await runLoop({ unattended: true, maxRounds: 4, alternate: false, toolResult: "ok" });
  expect(rounds).toBe(4);
  expect(written).toContain("the round cap of 4 was reached");
});

test("the round cap does nothing in an attended run", async () => {
  const { rounds } = await runLoop({ unattended: false, maxRounds: 4, alternate: false, toolResult: "ok" });
  expect(rounds).toBe(11);
});
