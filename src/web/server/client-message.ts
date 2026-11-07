import type { ApprovalAnswer } from "../../core/commands.ts";
import { HOOK_POINTS, type HookPoint, type ProfileDetail, type ProfileHook } from "../../core/notes.ts";
import { err, ok, type Result } from "../../core/result.ts";
import type { ClientMessage } from "../../protocol/protocol.ts";

const ANSWERS: string[] = ["approve", "refuse", "exit"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Reads a profile sent by the page. Each field is checked for its type and each hook point must exist;
// the store checks the rest (names, one-line commands) before it writes.
function profileOf(value: unknown): ProfileDetail | undefined {
  if (!isRecord(value)) return undefined;
  const { name, summary, text, tools, hooks } = value;
  if (typeof name !== "string" || typeof summary !== "string" || typeof text !== "string") return undefined;
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))) return undefined;
  if (!Array.isArray(hooks)) return undefined;
  const parsed: ProfileHook[] = [];
  for (const hook of hooks) {
    if (!isRecord(hook) || typeof hook.point !== "string" || typeof hook.command !== "string") return undefined;
    if (!(HOOK_POINTS as readonly string[]).includes(hook.point)) return undefined;
    parsed.push({ point: hook.point as HookPoint, command: hook.command });
  }
  const profile: ProfileDetail = { name, summary, text, hooks: parsed };
  if (tools !== undefined) profile.tools = tools as string[];
  return profile;
}

// Reads a message sent by the browser. The browser may send lines, approvals, and the two profile requests.
// Ending the input and failures come from the terminal, so a closed tab never ends the session.
export function parseClientMessage(text: string): Result<ClientMessage> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error("the message is not JSON"));
  }
  if (!isRecord(value)) return err(new Error("the message is not an object"));
  if (value.kind === "line" && typeof value.text === "string") {
    const shown = value.shown;
    if (shown === undefined) return ok({ kind: "line", text: value.text });
    if (typeof shown !== "number") return err(new Error("shown is not a number"));
    return ok({ kind: "line", text: value.text, shown });
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
  if (value.kind === "profileRead" && typeof value.name === "string") {
    return ok({ kind: "profileRead", name: value.name });
  }
  if (value.kind === "profileWrite") {
    const profile = profileOf(value.profile);
    if (profile === undefined) return err(new Error("the profile is not in the expected form"));
    return ok({ kind: "profileWrite", profile });
  }
  return err(new Error("unknown message"));
}
