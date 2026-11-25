import { describe, expect, test } from "bun:test";
import { openApproval, decideApproval } from "../chat/approvals";
import { replaceOnce } from "./edit-file";

describe("replaceOnce", () => {
  test("replaces the single occurrence", () => {
    expect(replaceOnce("alpha beta gamma", "beta", "delta")).toEqual({
      ok: true,
      value: "alpha delta gamma",
    });
  });

  test("keeps $ patterns in the new text literal", () => {
    expect(replaceOnce("price: X", "X", "$& $1")).toEqual({
      ok: true,
      value: "price: $& $1",
    });
  });

  test("refuses text that is not there", () => {
    expect(replaceOnce("alpha", "beta", "x")).toEqual({
      ok: false,
      error: "old_text was not found in the file.",
    });
  });

  test("refuses text that appears more than once", () => {
    expect(replaceOnce("a a", "a", "b").ok).toBe(false);
  });
});

describe("approvals", () => {
  test("a reply waiting on an approval continues with the user's answer", async () => {
    const pending = openApproval();
    expect(decideApproval(pending.id, true)).toBe(true);
    expect(await pending.decided).toBe(true);
    pending.close();
  });

  test("an answer to an id nobody is waiting on is refused", () => {
    expect(decideApproval("no-such-id", true)).toBe(false);
  });
});
