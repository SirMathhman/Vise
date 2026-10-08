import { expect, test } from "bun:test";
import { answerFrom, decideKey } from "../web/src/composer/ask-choices.ts";

const choices = ["Red", "Green", "Blue"];

test("a single answer is what was typed", () => {
  expect(answerFrom(choices, new Set(), "  something else ", false)).toBe(
    "something else",
  );
});

test("several allowed: the ticked choices in the order offered, then anything typed", () => {
  expect(answerFrom(choices, new Set([2, 0]), "", true)).toBe("Red, Blue");
  expect(answerFrom(choices, new Set([1]), "and a pinch of salt", true)).toBe(
    "Green, and a pinch of salt",
  );
  expect(answerFrom(choices, new Set(), "", true)).toBe("");
});

const idle = {
  key: "",
  modified: false,
  typing: false,
  onBox: false,
  choiceCount: 3,
  multi: false,
  selectedCount: 0,
};

test("number keys choose a numbered choice, only when not typing and only while there is one", () => {
  expect(decideKey({ ...idle, key: "1" })).toEqual({ type: "pick", index: 0 });
  expect(decideKey({ ...idle, key: "3" })).toEqual({ type: "pick", index: 2 });
  expect(decideKey({ ...idle, key: "4" })).toEqual({ type: "focusInput" });
  expect(decideKey({ ...idle, key: "0" })).toEqual({ type: "focusInput" });
  // In the reply box a digit is part of the reply.
  expect(decideKey({ ...idle, key: "2", typing: true })).toEqual({
    type: "none",
  });
});

test("Space chooses the highlighted choice, but is a space in the reply box", () => {
  expect(decideKey({ ...idle, key: " " })).toEqual({ type: "pickActive" });
  expect(decideKey({ ...idle, key: " ", typing: true })).toEqual({
    type: "none",
  });
});

test("arrows move the highlight while there are choices", () => {
  expect(decideKey({ ...idle, key: "ArrowDown" })).toEqual({
    type: "move",
    by: 1,
  });
  expect(decideKey({ ...idle, key: "ArrowUp", typing: true })).toEqual({
    type: "move",
    by: -1,
  });
  expect(decideKey({ ...idle, key: "ArrowDown", choiceCount: 0 })).toEqual({
    type: "none",
  });
});

test("Enter confirms in the reply box or on the question, and sends what is ticked when several are allowed", () => {
  expect(decideKey({ ...idle, key: "Enter", typing: true })).toEqual({
    type: "confirm",
  });
  expect(decideKey({ ...idle, key: "Enter", onBox: true })).toEqual({
    type: "confirm",
  });
  // On a choice button Enter is the browser's own click, unless ticked choices are waiting to be sent.
  expect(decideKey({ ...idle, key: "Enter" })).toEqual({ type: "none" });
  expect(
    decideKey({ ...idle, key: "Enter", multi: true, selectedCount: 2 }),
  ).toEqual({ type: "confirm" });
});

test("a letter moves into the reply box, a shortcut does not", () => {
  expect(decideKey({ ...idle, key: "a" })).toEqual({ type: "focusInput" });
  expect(decideKey({ ...idle, key: "c", modified: true })).toEqual({
    type: "none",
  });
  expect(decideKey({ ...idle, key: "a", typing: true })).toEqual({
    type: "none",
  });
});
