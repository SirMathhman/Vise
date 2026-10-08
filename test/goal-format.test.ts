import { expect, test } from "bun:test";
import { formatGoalEvent } from "../src/output/format.ts";

const verdict = (v: "yes" | "no" | "blocked", continuing: boolean) =>
  ({ kind: "verdict", verdict: v, detail: "d", continuing }) as const;

test("a plain continue is not shown", () => {
  expect(formatGoalEvent(verdict("no", true))).toBeUndefined();
});

test("the goal, success and being blocked still are", () => {
  expect(formatGoalEvent({ kind: "goal", goal: "g", doneWhen: "w" })?.level).toBe("info");
  expect(formatGoalEvent(verdict("yes", false))?.level).toBe("ok");
  expect(formatGoalEvent(verdict("blocked", false))?.level).toBe("ask");
  expect(formatGoalEvent(verdict("no", false))?.text).toContain("not done yet");
});
