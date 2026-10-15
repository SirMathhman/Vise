import { expect, test } from "bun:test";
import {
  cosine,
  decodeVector,
  encodeVector,
  topScored,
} from "../../packages/backend/src/stores/semantic/vectors.ts";

test("a vector survives the database's bytes, even from an unaligned view", () => {
  const original = [0.25, -1.5, 3, 0];
  const bytes = encodeVector(original);
  expect([...decodeVector(bytes, 4)]).toEqual(original);
  const padded = new Uint8Array(bytes.length + 3);
  padded.set(bytes, 3);
  expect([...decodeVector(padded.subarray(3), 4)]).toEqual(original);
});

test("cosine is 1 for the same direction, 0 for orthogonal, -1 for opposite, 0 for a zero vector", () => {
  expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  expect(cosine([0, 0], [1, 1])).toBe(0);
});

test("the best items come first and no more than the limit", () => {
  const top = topScored(
    [
      { score: 0.2, item: "a" },
      { score: 0.9, item: "b" },
      { score: 0.5, item: "c" },
    ],
    2,
  );
  expect(top.map((t) => t.item)).toEqual(["b", "c"]);
});
