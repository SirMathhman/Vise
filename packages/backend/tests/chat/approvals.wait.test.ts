import { describe, expect, test } from "bun:test";
import {
  decideApproval,
  openApproval,
  waitForApproval,
} from "../../src/chat/approvals";

describe("waitForApproval", () => {
  test("returns the user's answer and releases the approval", async () => {
    const pending = openApproval();
    const waiting = waitForApproval(pending, undefined, 5_000);
    decideApproval(pending.id, "approve");
    expect(await waiting).toBe(true);
    expect(decideApproval(pending.id, "reject")).toBe(false);
  });

  test("gives up after the timeout and releases the approval", async () => {
    const pending = openApproval();
    expect(await waitForApproval(pending, undefined, 10)).toBeUndefined();
    expect(decideApproval(pending.id, "approve")).toBe(false);
  });

  test("gives up when the client goes away and releases the approval", async () => {
    const pending = openApproval();
    const controller = new AbortController();
    const waiting = waitForApproval(pending, controller.signal, 5_000);
    controller.abort();
    expect(await waiting).toBeUndefined();
    expect(decideApproval(pending.id, "approve")).toBe(false);
  });

  test("does not wait at all when the client is already gone", async () => {
    const pending = openApproval();
    const controller = new AbortController();
    controller.abort();
    expect(
      await waitForApproval(pending, controller.signal, 5_000),
    ).toBeUndefined();
  });
});
