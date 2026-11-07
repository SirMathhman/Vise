import { expect, test } from "bun:test";
import { parseClientMessage } from "./client-message.ts";

test("a line and an approval are read; end of input and failures are refused", () => {
  expect(parseClientMessage('{"kind":"line","text":"hi"}')).toEqual({
    ok: true,
    value: { kind: "line", text: "hi" },
  });
  expect(
    parseClientMessage('{"kind":"approval","id":3,"answer":"approve"}'),
  ).toEqual({ ok: true, value: { kind: "approval", id: 3, answer: "approve" } });
  expect(parseClientMessage('{"kind":"inputEnded"}').ok).toBe(false);
  expect(parseClientMessage('{"kind":"failed","message":"x"}').ok).toBe(false);
  expect(parseClientMessage("not json").ok).toBe(false);
  expect(parseClientMessage('{"kind":"approval","id":3,"answer":"yes"}').ok).toBe(
    false,
  );
});

test("a profile write is read when its fields have the right types and hook points, and refused otherwise", () => {
  const good = { kind: "profileWrite", profile: { name: "p", summary: "s", text: "t", hooks: [{ point: "sessionStart", command: "echo" }] } };
  expect(parseClientMessage(JSON.stringify(good)).ok).toBe(true);
  const badPoint = { kind: "profileWrite", profile: { name: "p", summary: "s", text: "t", hooks: [{ point: "later", command: "echo" }] } };
  expect(parseClientMessage(JSON.stringify(badPoint)).ok).toBe(false);
  const badType = { kind: "profileWrite", profile: { name: 3, summary: "s", text: "t", hooks: [] } };
  expect(parseClientMessage(JSON.stringify(badType)).ok).toBe(false);
  expect(parseClientMessage('{"kind":"profileRead","name":"p"}')).toEqual({
    ok: true,
    value: { kind: "profileRead", name: "p" },
  });
});
