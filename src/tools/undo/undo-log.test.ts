import { expect, test } from "bun:test";
import {
  type Bytes,
  createLog,
  isKeptDistance,
  planRevert,
  pointsOf,
  recordBefore,
  startTurn,
} from "./undo-log.ts";

const text = (value: string): Bytes => new TextEncoder().encode(value);
const read = (bytes: Bytes): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

// Six turns, each of which changes the file "a" from the content of the turn before to its own: turn k
// leaves "vk". The file starts as "v0".
function sixTurns() {
  const log = createLog();
  let current: Bytes = text("v0");
  for (let turn = 1; turn <= 6; turn++) {
    startTurn(log);
    recordBefore(log, "a", current);
    current = text(`v${turn}`);
  }
  return log;
}

test("the kept distances are 1, 2, 3, 5, 8, and so on", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8].filter(isKeptDistance)).toEqual([1, 2, 3, 5, 8]);
});

test("after six turns the points are 1, 2, 3, and 5 turns back", () => {
  expect(pointsOf(sixTurns())).toEqual([1, 2, 3, 5]);
});

test("reverting to a point gives the bytes the file had at the start of that turn", () => {
  const log = sixTurns();
  expect(read(planRevert(log, 1)?.get("a"))).toBe("v5");
  expect(read(planRevert(log, 2)?.get("a"))).toBe("v4");
  expect(read(planRevert(log, 3)?.get("a"))).toBe("v3");
  // Turn 3 back was dropped into the turn 5 back, and the earlier record is kept.
  expect(read(planRevert(log, 5)?.get("a"))).toBe("v1");
});

test("a turn that did not exist, or a distance that is not kept, has no plan", () => {
  const log = sixTurns();
  expect(planRevert(log, 4)).toBeUndefined();
  expect(planRevert(log, 8)).toBeUndefined();
});

test("a file that did not exist before a turn is planned as removed", () => {
  const log = createLog();
  startTurn(log);
  recordBefore(log, "new.txt", undefined);
  expect(planRevert(log, 1)?.get("new.txt")).toBeUndefined();
  expect(planRevert(log, 1)?.has("new.txt")).toBe(true);
});
