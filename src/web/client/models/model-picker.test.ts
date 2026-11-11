import { expect, test } from "bun:test";
import { offered } from "./model-picker.ts";

const models = [
  { id: "a::x", contextLength: 1 },
  { id: "a::y", contextLength: 1 },
  { id: "b::z", contextLength: 1 },
];

test("the filter narrows the models, and the current model is offered even when the filter hides it", () => {
  expect(offered(models, "", "")).toEqual(["a::x", "a::y", "b::z"]);
  expect(offered(models, "", "y")).toEqual(["a::y"]);
  expect(offered(models, "a::x", "z")).toEqual(["a::x", "b::z"]);
  expect(offered(models, "gone", "")).toEqual(["gone", "a::x", "a::y", "b::z"]);
});
