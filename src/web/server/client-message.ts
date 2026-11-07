import type { ApprovalAnswer } from "../../core/commands.ts";
import { err, ok, type Result } from "../../core/result.ts";
import type { ClientMessage } from "../../protocol/protocol.ts";

const ANSWERS: string[] = ["approve", "refuse", "exit"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Reads a message sent by the browser. The browser may send only lines and approvals. Ending the
// input and failures come from the terminal, so a closed tab never ends the session.
export function parseClientMessage(text: string): Result<ClientMessage> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error("the message is not JSON"));
  }
  if (!isRecord(value)) return err(new Error("the message is not an object"));
  if (value.kind === "line" && typeof value.text === "string") {
    return ok({ kind: "line", text: value.text });
  }
  if (
    value.kind === "approval" &&
    typeof value.id === "number" &&
    typeof value.answer === "string" &&
    ANSWERS.includes(value.answer)
  ) {
    return ok({
      kind: "approval",
      id: value.id,
      answer: value.answer as ApprovalAnswer,
    });
  }
  return err(new Error("unknown message"));
}
