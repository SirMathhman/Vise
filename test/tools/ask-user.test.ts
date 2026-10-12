import { describe, expect, test } from "bun:test";
import {
  type AskRequest,
  makeAskUserHandler,
  type UserPrompter,
} from "../../packages/backend/src/tools/agent/ask-user.ts";

/** A UserPrompter that records each call and returns a fixed answer. */
function stubPrompter(answer: string): {
  prompter: UserPrompter;
  calls: AskRequest[];
} {
  const calls: AskRequest[] = [];
  const prompter: UserPrompter = {
    async ask(request: AskRequest) {
      calls.push(request);
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
    expect(calls).toEqual([
      { question: "Continue?", options: [], multiSelect: false },
    ]);
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

  test("passes multi_select true through to the prompter", async () => {
    const { prompter, calls } = stubPrompter("1,3");
    const handler = makeAskUserHandler(prompter);
    const result = await handler({
      question: "Pick any",
      options: ["a", "b", "c"],
      multi_select: true,
    });
    expect(result).toBe("user replied: 1,3");
    expect(calls).toEqual([
      { question: "Pick any", options: ["a", "b", "c"], multiSelect: true },
    ]);
  });

  test("accepts {label, description} options and passes descriptions separately", async () => {
    const { prompter, calls } = stubPrompter("A");
    const handler = makeAskUserHandler(prompter);
    await handler({
      question: "Pick",
      options: [{ label: "A", description: "first" }, "B"],
    });
    expect(calls).toEqual([
      { question: "Pick", options: ["A", "B"], descriptions: ["first", ""], multiSelect: false },
    ]);
  });

  test("refuses newline-joined choices so the model asks again", async () => {
    const { prompter, calls } = stubPrompter("x");
    const handler = makeAskUserHandler(prompter);
    const result = await handler({ question: "Pick", options: ["one\ntwo\nthree"] });
    expect(result).toContain("one choice per list element");
    expect(calls).toEqual([]);
  });

  test("refuses a parameter name used as a choice", async () => {
    const { prompter, calls } = stubPrompter("x");
    const handler = makeAskUserHandler(prompter);
    const result = await handler({ question: "Pick", options: ["Just the list", "multi_select"] });
    expect(result).toContain("parameter name");
    expect(calls).toEqual([]);
  });

  test("refuses an empty or non-string option", async () => {
    const { prompter } = stubPrompter("x");
    const handler = makeAskUserHandler(prompter);
    expect(await handler({ question: "Pick", options: ["a", ""] })).toContain("non-empty");
    expect(await handler({ question: "Pick", options: [3] })).toContain("non-empty");
  });

  test("defaults multi_select to false when not provided", async () => {
    const { prompter, calls } = stubPrompter("x");
    const handler = makeAskUserHandler(prompter);
    await handler({ question: "Pick", options: ["a", "b"] });
    expect(calls).toEqual([
      { question: "Pick", options: ["a", "b"], multiSelect: false },
    ]);
  });
});
