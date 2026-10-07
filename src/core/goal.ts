import type { Client, Tool } from "./engine.ts";
import type { Message } from "./errors.ts";

/**
 * Goal tracking. A model that has been working can stop on a sentence like
 * "Let me open that page" without calling anything, or declare victory early.
 * So each turn runs against an explicit goal: it is derived from the
 * conversation when the user speaks, and once the model stops, a throwaway
 * question asks whether the goal was actually met. Both calls are appended to
 * the conversation only for the one request (never stored), answer in
 * schema-constrained JSON, and fail open: anything unparseable counts as "met"
 * so a misbehaving check can never trap the user in a loop.
 *
 * Pure: depends only on `Client`.
 */

/** What the agent is working toward, and how to tell it is done. */
export interface Goal {
  text: string;
  doneWhen: string;
}

/** The judgement after a turn: finished, more to do, or waiting on the user. */
export interface Verdict {
  kind: "yes" | "no" | "blocked";
  /** The evidence (yes), the single next step (no) or what is needed from the user (blocked). */
  detail: string;
}

const GOAL_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string" },
    done_when: { type: "string" },
  },
  required: ["goal", "done_when"],
  additionalProperties: false,
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { enum: ["yes", "no", "blocked"] },
    detail: { type: "string" },
  },
  required: ["verdict", "detail"],
  additionalProperties: false,
};

/** Ask the model for JSON matching `schema`, as a one-off question at the end of the conversation. */
async function ask(
  client: Client,
  messages: Message[],
  toolDefs: Tool[],
  question: string,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.chat(
    [...messages, { role: "user", content: question }],
    toolDefs,
    undefined,
    undefined,
    undefined,
    schema,
    signal,
  );
  if (!result.ok) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.value.content);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * The goal for the user's latest message: the current goal when the message
 * continues it ("?", "ok", new details), otherwise a new one. Returns the
 * current goal unchanged (or undefined) when the model cannot be asked.
 */
export async function deriveGoal(
  client: Client,
  messages: Message[],
  toolDefs: Tool[],
  current: Goal | undefined,
  signal?: AbortSignal,
): Promise<Goal | undefined> {
  const known = current
    ? `Current goal: ${current.text} (done when: ${current.doneWhen})`
    : "There is no current goal.";
  const reply = await ask(
    client,
    messages,
    toolDefs,
    `[goal tracking, not from the user] ${known}\nThe user's latest message is above. Reply with JSON. "goal": the objective the user wants accomplished, in one sentence. If the latest message continues, answers or refines the current goal (for example "?", "ok", "try again", or new details for the same task), keep the current goal and fold in anything new. If it asks for something unrelated, give a new goal. For a plain question or chat, the goal is to answer it. "done_when": what will observably be true once the goal is complete.`,
    GOAL_SCHEMA,
    signal,
  );
  const goal = text(reply?.["goal"]);
  if (goal === "") return current;
  return { text: goal, doneWhen: text(reply?.["done_when"]) };
}

/** Whether the goal has been accomplished, judged from what actually happened in the conversation. */
export async function checkGoal(
  client: Client,
  messages: Message[],
  toolDefs: Tool[],
  goal: Goal,
  signal?: AbortSignal,
): Promise<Verdict> {
  const reply = await ask(
    client,
    messages,
    toolDefs,
    `[goal check, not from the user] Goal: ${goal.text}\nDone when: ${goal.doneWhen}\nJudge only from what has actually happened in this conversation, not from what you intended to do. Reply with JSON. "verdict": "yes" if the goal is fully accomplished (detail: the evidence, quoting the result that proves it); "no" if there is still more to do that you can do yourself right now (detail: the single next step); "blocked" if you cannot go on without the user, such as a decision, a confirmation before something irreversible, personal details or a login (detail: exactly what you need from them).`,
    VERDICT_SCHEMA,
    signal,
  );
  const kind = reply?.["verdict"];
  const detail = text(reply?.["detail"]);
  if (kind === "no" || kind === "blocked") return { kind, detail };
  return { kind: "yes", detail };
}

/** The message that sends the model back to work after a "no" verdict. */
export function continueNote(goal: Goal, verdict: Verdict): string {
  return `Your goal is not met yet: ${goal.text}\nNext step: ${verdict.detail}\nDo it now by calling the tool, without describing it first.`;
}
