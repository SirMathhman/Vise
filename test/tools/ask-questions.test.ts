import { expect, test } from "bun:test";
import { makeAskUserHandler, type AskRequest } from "../../packages/backend/src/tools/agent/ask-user.ts";

test("several questions are asked in turn and answered together", async () => {
  const asked: string[] = [];
  const run = makeAskUserHandler({
    ask: async (r: AskRequest) => {
      asked.push(r.question);
      return `a${asked.length}`;
    },
  });
  const out = await run({ questions: [{ question: "One?" }, { question: "Two?", options: ["x"] }] });
  expect(asked).toEqual(["One?", "Two?"]);
  expect(out).toBe("1. One? → a1\n2. Two? → a2");
});

test("a single question and a bad list still behave", async () => {
  const run = makeAskUserHandler({ ask: async () => "yes" });
  expect(await run({ question: "Ok?" })).toBe("user replied: yes");
  expect(await run({ questions: [] })).toContain("non-empty list");
  expect(await run({ questions: [{}] })).toContain("'question'");
});
