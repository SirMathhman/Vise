import { expect, test } from "bun:test";
import { answerFrom, askKey } from "../web/src/ask-choices.ts";

const choices = ["Red", "Green", "Blue"];

test("a single answer is what was typed", () => {
  expect(answerFrom(choices, new Set(), "  something else ", false)).toBe("something else");
});

test("several allowed: the ticked choices in the order offered, then anything typed", () => {
  expect(answerFrom(choices, new Set([2, 0]), "", true)).toBe("Red, Blue");
  expect(answerFrom(choices, new Set([1]), "and a pinch of salt", true)).toBe("Green, and a pinch of salt");
  expect(answerFrom(choices, new Set(), "", true)).toBe("");
});

test("number keys choose a numbered choice, only while there is one", () => {
  expect(askKey("1", 3)).toEqual({ type: "pick", index: 0 });
  expect(askKey("3", 3)).toEqual({ type: "pick", index: 2 });
  expect(askKey("4", 3)).toEqual({ type: "none" });
  expect(askKey("0", 3)).toEqual({ type: "none" });
});

test("arrows move the highlight, Enter confirms, other keys do nothing", () => {
  expect(askKey("ArrowDown", 3)).toEqual({ type: "move", by: 1 });
  expect(askKey("ArrowUp", 3)).toEqual({ type: "move", by: -1 });
  expect(askKey("Enter", 3)).toEqual({ type: "enter" });
  expect(askKey("a", 3)).toEqual({ type: "none" });
});
