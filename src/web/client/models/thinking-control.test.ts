import { expect, test } from "bun:test";
import { controlShown } from "./thinking-control.ts";

test("until the level is known, the control is blank and disabled", () => {
  expect(controlShown(undefined, true)).toEqual({ disabled: true, value: "" });
});

test("once the level is known, the control shows it and is enabled when the page may send", () => {
  expect(controlShown("high", true)).toEqual({ disabled: false, value: "high" });
  expect(controlShown("off", true)).toEqual({ disabled: false, value: "off" });
});

test("the control is disabled while the page may not send, even with a level known", () => {
  expect(controlShown("low", false)).toEqual({ disabled: true, value: "low" });
});
