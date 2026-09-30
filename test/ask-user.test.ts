import { describe, test, expect } from "bun:test";
import {
  makeAskUserHandler,
  type UserPrompter,
} from "../src/tools/ask-user.ts";

/** A UserPrompter that records each call and returns a fixed answer. */
function stubPrompter(answer: string): {
  prompter: UserPrompter;
  calls: { question: string; options: string[] }[];
} {
  const calls: { question: string; options: string[] }[] = [];
  const prompter: UserPrompter = {
    async ask(question: string, options: string[]) {
      calls.push({ question, options });
      return answer;
    },
  };
  return { prompter, calls };
}

describe("makeAskUserHandler (edge)", () => {
  test("returns the user's answer as the tool result", async () => {
    const { prompter, calls } = stubPrompter("yes");
    const handler = makeAskUserHandler(prompter);
    const result = await handler({ question: "Continue?" });
    expect(result).toBe("user replied: yes");
    expect(calls).toEqual([{ question: "Continue?", options: [] }]);
  });

  test("passes options through to the prompter", async () => {
    const { prompter } = stubPrompter("b");
    const handler = makeAskUserHandler(prompter);
    const result = await handler({
      question: "Pick one",
      options: ["a", "b"],
    });
    expect(result).toBe("user replied: b");
  });

  test("returns an error string when the question is missing", async () => {
    const { prompter } = stubPrompter("x");
    const handler = makeAskUserHandler(prompter);
    const result = await handler({});
    expect(result).toBe(
      "error: ask_user requires a non-empty 'question' argument",
    );
  });

  test("returns an error string when the question is empty", async () => {
    const { prompter } = stubPrompter("x");
    const handler = makeAskUserHandler(prompter);
    const result = await handler({ question: "   " });
    expect(result).toBe(
      "error: ask_user requires a non-empty 'question' argument",
    );
  });

  test("returns an error string when the prompter receives no input", async () => {
    const { prompter } = stubPrompter("");
    const handler = makeAskUserHandler(prompter);
    const result = await handler({ question: "Continue?" });
    expect(result).toBe("error: ask_user was cancelled (no input received)");
  });
});
