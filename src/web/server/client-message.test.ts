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
