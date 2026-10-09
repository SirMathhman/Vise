import { describe, expect, test } from "bun:test";
import { config } from "../../src/config.ts";
import type { Client } from "../../src/core/engine.ts";
import type { Message, Result } from "../../src/core/errors.ts";
import {
  capTrace,
  type GoalTraceFact,
  TRACE_TEXT_MAX,
} from "../../src/core/goal-trace.ts";
import { GoalTracker } from "../../src/repl/turn/goal-loop.ts";

type Reply = Record<string, string> | undefined;

/** A model that answers each hidden question from a script (undefined: the call fails). */
function scripted(script: {
  goal?: Reply;
  verdict?: (n: number) => Reply;
  progress?: Reply;
}): Client {
  let checks = 0;
  return {
    chat: async (messages: Message[]) => {
      const question = messages[messages.length - 1]?.content ?? "";
      let reply: Reply;
      if (question.startsWith("[goal tracking")) {
        reply = script.goal ?? { goal: "g", done_when: "d" };
      } else if (question.startsWith("[goal check")) {
        reply = script.verdict?.(checks++);
      } else {
        reply = script.progress;
      }
      return reply === undefined
        ? { ok: false, error: { kind: "network", cause: "socket closed" } }
        : { ok: true, value: { content: JSON.stringify(reply) } };
    },
  };
}

const verdict = (v: string, detail = "because"): Reply => ({ verdict: v, detail });
const ok = (value = "done"): Result<string> => ({ ok: true, value });

interface Setup {
  facts: GoalTraceFact[];
  tracker: GoalTracker;
  messages: Message[];
}

function setup(enabled = true, messages?: Message[]): Setup {
  const facts: GoalTraceFact[] = [];
  const tracker = new GoalTracker(enabled, undefined, (f) => facts.push(f));
  return {
    facts,
    tracker,
    messages: messages ?? [{ role: "user", content: "do it" }],
  };
}

const exits = (facts: GoalTraceFact[]) =>
  facts.flatMap((f) => (f.kind === "exit" ? [f] : []));

/** A turn that runs one tool and says something. */
const working = (messages: Message[]) => async (): Promise<Result<string>> => {
  messages.push({ role: "tool", content: "result" });
  messages.push({ role: "assistant", content: "I did a thing" });
  return ok();
};

describe("goal trace", () => {
  test.each([
    ["yes", "met"],
    ["blocked", "blocked"],
  ])("a %s verdict ends the turn with the exit reason %s", async (v, reason) => {
    const { facts, tracker, messages } = setup();
    await tracker.run(scripted({ verdict: () => verdict(v) }), messages, [], working(messages), new AbortController().signal);
    expect(exits(facts)).toHaveLength(1);
    expect(exits(facts)[0]).toMatchObject({ reason, detail: "because", lastReply: "I did a thing", toolResults: 1 });
    // The hidden calls are in the trace with their exact question and raw reply.
    const asks = facts.flatMap((f) => (f.kind === "ask" ? [f] : []));
    expect(asks.map((a) => a.purpose)).toEqual(["goal", "goal-check"]);
    expect(asks[1]?.question).toContain("Goal: g");
    expect(asks[1]?.reply).toContain(v);
    expect(facts.find((f) => f.kind === "goal")).toMatchObject({ goal: "g", fallback: false });
  });

  test("a check that cannot be made is traced as unknown with the failure", async () => {
    const { facts, tracker, messages } = setup();
    await tracker.run(scripted({ verdict: () => undefined }), messages, [], working(messages), new AbortController().signal);
    const failed = facts.filter((f) => f.kind === "ask" && f.failure !== undefined);
    expect(failed).toHaveLength(3); // every attempt
    expect(exits(facts)[0]).toMatchObject({ reason: "unknown", detail: expect.stringContaining("socket closed") });
  });

  test("a goal that could not be derived falls back to the user's words, and says so", async () => {
    const { facts, tracker, messages } = setup();
    const client = scripted({ goal: { goal: "", done_when: "" }, verdict: () => verdict("yes") });
    await tracker.run(client, messages, [], working(messages), new AbortController().signal);
    expect(facts.find((f) => f.kind === "goal")).toMatchObject({ goal: "do it", fallback: true });
  });

  test("a continue records the note that is kept out of the saved conversation, and whether tools ran", async () => {
    const { facts, tracker, messages } = setup();
    const answers = [verdict("no", "open the file"), verdict("yes")];
    await tracker.run(scripted({ verdict: (n) => answers[n] }), messages, [], working(messages), new AbortController().signal);
    const cont = facts.find((f) => f.kind === "continue");
    expect(cont).toMatchObject({ continues: 1, repeats: 0, toolsRan: true });
    expect(cont?.kind === "continue" && cont.note).toContain("Next step: open the file");
    expect(exits(facts)[0]?.reason).toBe("met");
  });

  test("the same step again with nothing done ends the turn as same-step", async () => {
    const { facts, tracker, messages } = setup();
    await tracker.run(
      scripted({ verdict: () => verdict("no", "same step") }),
      messages,
      [],
      async () => ok(), // no tool runs
      new AbortController().signal,
    );
    expect(exits(facts)).toHaveLength(1);
    expect(exits(facts)[0]).toMatchObject({ reason: "same-step", detail: "same step" });
  });

  test("declining to go on after many continues ends the turn as max-continues-declined", async () => {
    const { facts, tracker, messages } = setup();
    await tracker.run(
      scripted({ verdict: (n) => verdict("no", `step ${n}`) }),
      messages,
      [],
      working(messages),
      new AbortController().signal,
      { confirmMore: async () => false },
    );
    expect(exits(facts)).toHaveLength(1);
    expect(exits(facts)[0]?.reason).toBe("max-continues-declined");
    expect(facts.filter((f) => f.kind === "continue")).toHaveLength(config.continuesBeforeAsking);
  });

  test("a stuck progress check the user declines to override halts the turn", async () => {
    const { facts, tracker, messages } = setup();
    const client = scripted({ verdict: () => verdict("yes"), progress: { progress: "stuck", detail: "going in circles" } });
    const signal = new AbortController().signal;
    await tracker.run(client, messages, [], async () => {
      await tracker.progress(client, messages, [], signal, async () => false);
      return ok();
    }, signal);
    expect(facts.find((f) => f.kind === "progress")).toMatchObject({ progress: "stuck", keepGoing: false });
    expect(exits(facts)[0]).toMatchObject({ reason: "halted-progress", detail: "going in circles" });
  });

  test("with goal checking off the turn is traced as goal-off", async () => {
    const { facts, tracker, messages } = setup(false);
    await tracker.run(scripted({}), messages, [], async () => ok(), new AbortController().signal);
    expect(facts.map((f) => f.kind)).toEqual(["turn_start", "exit"]);
    expect(facts[0]).toMatchObject({ kind: "turn_start", enabled: false });
    expect(exits(facts)[0]?.reason).toBe("goal-off");
  });

  test("switching goal checking is traced", () => {
    const { facts, tracker } = setup(true);
    tracker.enabled = false;
    expect(facts).toEqual([{ kind: "setting", enabled: false }]);
  });

  test("no goal to work toward is traced as no-goal", async () => {
    const { facts, tracker } = setup(true, []);
    const client = scripted({ goal: { goal: "", done_when: "" } });
    await tracker.run(client, [], [], async () => ok(), new AbortController().signal);
    expect(exits(facts)[0]?.reason).toBe("no-goal");
  });

  test("a turn that fails is traced as turn-failed with the error", async () => {
    const { facts, tracker, messages } = setup();
    await tracker.run(
      scripted({ verdict: () => verdict("yes") }),
      messages,
      [],
      async () => ({ ok: false, error: { kind: "network", cause: "connection reset" } }),
      new AbortController().signal,
    );
    expect(exits(facts)[0]).toMatchObject({ reason: "turn-failed", detail: expect.stringContaining("connection reset") });
    expect(facts.some((f) => f.kind === "verdict")).toBeFalse();
  });

  test("an interrupt is traced as interrupted", async () => {
    const { facts, tracker, messages } = setup();
    const abort = new AbortController();
    const result = await tracker.run(
      scripted({ verdict: () => verdict("yes") }),
      messages,
      [],
      async () => {
        abort.abort();
        return ok();
      },
      abort.signal,
    );
    expect(result.ok).toBeFalse();
    expect(exits(facts)[0]?.reason).toBe("interrupted");
  });

  test("an exception is traced, once, and still thrown", async () => {
    const { facts, tracker, messages } = setup();
    const run = tracker.run(
      scripted({}),
      messages,
      [],
      async () => {
        throw new Error("kaboom");
      },
      new AbortController().signal,
    );
    await expect(run).rejects.toThrow("kaboom");
    expect(exits(facts)).toHaveLength(1);
    expect(exits(facts)[0]).toMatchObject({ reason: "exception", detail: expect.stringContaining("kaboom") });
  });

  test("long text is capped", () => {
    const capped = capTrace("x".repeat(TRACE_TEXT_MAX + 500));
    expect(capped.length).toBeLessThan(TRACE_TEXT_MAX + 60);
    expect(capped).toContain("500 more characters");
    expect(capTrace("short")).toBe("short");
  });
});
