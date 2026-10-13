import type { Client, Tool } from "./engine.ts";
import type { CallPurpose, Message, ViseError } from "./errors.ts";
import { capTrace, type TraceSink } from "./goal-trace.ts";

/**
 * Goal tracking. A model that has been working can stop on a sentence like
 * "Let me open that page" without calling anything, or declare victory early.
 * So each turn runs against an explicit goal: it is derived from the
 * conversation when the user speaks, and once the model stops, a throwaway
 * question asks whether the goal was actually met. Both calls are appended to
 * the conversation only for the one request (never stored), answer in
 * schema-constrained JSON, and never loop on a broken check: a call that fails
 * is asked again (up to `ASK_ATTEMPTS`
 * times). The goal check then reports "unknown" with the exact reason (it never
 * claims "met" for a check that did not run), and the turn ends with the goal
 * kept. The goal and progress checks fall back to the user's words and to
 * "progressing", so they never cut work short.
 *
 * Pure: depends only on `Client`.
 */

/** What the agent is working toward, and how to tell it is done. */
export interface Goal {
  text: string;
  doneWhen: string;
  /** A restriction the user put on how to proceed that is still in force ("don't submit yet", "wait"); absent when none. */
  hold?: string;
}

/** The judgement after a turn: finished, more to do, or waiting on the user. */
export interface Verdict {
  kind: "yes" | "no" | "blocked" | "unknown";
  /** The evidence (yes), the single next step (no), what is needed from the user (blocked) or why the check could not be made (unknown). */
  detail: string;
}

const GOAL_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string" },
    done_when: { type: "string" },
    hold: { type: "string" },
  },
  required: ["goal", "done_when", "hold"],
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

/** How many times a check is asked before giving up. */
const ASK_ATTEMPTS = 3;

/** What a failed attempt was, in words that say what went wrong (not just "failed"). */
function describeError(error: ViseError): string {
  switch (error.kind) {
    case "http":
      return `the server answered HTTP ${error.status}: ${error.body.slice(0, 200)}`;
    case "network":
      return `the connection to the model failed: ${error.cause}`;
    case "malformed":
      return `the server's reply could not be read: ${error.body.slice(0, 200)}`;
    case "storage":
      return `storage failed: ${error.cause}`;
    case "runaway":
      return `the call was stopped as a runaway: ${error.detail}`;
    case "interrupted":
      return "the call was interrupted";
  }
}

/** The reply to a one-off question, or exactly why there is none. */
type Asked =
  { ok: true; reply: Record<string, unknown> } | { ok: false; why: string };

/**
 * Ask the model for JSON matching `schema`, as a one-off question at the end of
 * the conversation. The request is constrained to the schema (the server
 * decodes only tokens that keep the reply valid), so the reply is trusted to
 * have its shape: a wrong shape is not something the model can produce. A call
 * that fails is asked again; after `ASK_ATTEMPTS` the answer is why the last
 * attempt failed.
 */
async function ask(
  client: Client,
  messages: Message[],
  toolDefs: Tool[],
  question: string,
  schema: Record<string, unknown>,
  purpose: CallPurpose,
  signal?: AbortSignal,
  trace?: TraceSink,
): Promise<Asked> {
  let why = "no attempt was made";
  for (let attempt = 0; attempt < ASK_ATTEMPTS; attempt++) {
    const asked = { kind: "ask" as const, purpose, attempt: attempt + 1, question: capTrace(question) };
    const result = await (client.as?.(purpose) ?? client).chat(
      [...messages, { role: "user", content: question }],
      toolDefs,
      undefined,
      undefined,
      undefined,
      schema,
      signal,
    );
    if (!result.ok) {
      why = describeError(result.error);
      trace?.({ ...asked, failure: why });
      if (result.error.kind === "interrupted" || signal?.aborted) break;
      continue;
    }
    try {
      const reply = JSON.parse(result.value.content);
      trace?.({ ...asked, reply: capTrace(result.value.content) });
      return { ok: true, reply };
    } catch {
      // Only a server that ignored the schema gets here; asking again would not change that.
      const bad = `the server did not apply the response schema (reply: ${result.value.content.slice(0, 200)})`;
      trace?.({ ...asked, reply: capTrace(result.value.content), failure: bad });
      return { ok: false, why: bad };
    }
  }
  return { ok: false, why };
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** What the user last said (skipping `skip`ped messages, such as the notes that send the model back to work). */
function lastUserText(
  messages: Message[],
  skip: (m: Message) => boolean,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && !skip(m)) return m.content.trim();
  }
  return "";
}

/**
 * The goal for the user's latest message: the current goal when the message
 * continues it ("?", "ok", new details), otherwise a new one. When the model
 * cannot be asked (or answers nothing usable) the goal is simply what the user
 * said, never the previous goal: a stale goal must not hijack an unrelated
 * message.
 */
export async function deriveGoal(
  client: Client,
  messages: Message[],
  toolDefs: Tool[],
  current: Goal | undefined,
  signal?: AbortSignal,
  skip: (m: Message) => boolean = () => false,
  trace?: TraceSink,
): Promise<Goal | undefined> {
  const known = current
    ? `Current goal: ${current.text} (done when: ${current.doneWhen})${current.hold ? ` Current hold: ${current.hold}` : ""}`
    : "There is no current goal.";
  // Quoted, because "the latest message above" is ambiguous in a conversation that opens with the
  // project map and notes: a weaker model answered with a goal about those instead of the request.
  const latest = JSON.stringify(lastUserText(messages, skip).slice(0, 400));
  const reply = await ask(
    client,
    messages,
    toolDefs,
    `[goal tracking, not from the user] ${known}\nThe user's latest message is above; it reads: ${latest}. Reply with JSON. "goal": the objective the user wants accomplished, in one sentence. If the latest message continues, answers or refines the current goal (for example "?", "ok", "try again", or new details for the same task), keep the current goal and fold in anything new. If it asks for something unrelated, give a new goal. For a plain question or chat, the goal is to answer it. "done_when": what will observably be true once the goal is complete. "hold": a restriction the user has put on how to proceed that is still in force (for example: not to submit or send something yet, to wait, to ask first), in their words, or an empty string. Keep the current hold unless the user's latest message lifts or replaces it.`,
    GOAL_SCHEMA,
    "goal",
    signal,
    trace,
  );
  const goal = reply.ok ? text(reply.reply["goal"]) : "";
  if (goal !== "") {
    const doneWhen = text(reply.ok ? reply.reply["done_when"] : "");
    const hold = text(reply.ok ? reply.reply["hold"] : "");
    trace?.({ kind: "goal", goal, doneWhen, hold, previous: current?.text, fallback: false });
    return hold ? { text: goal, doneWhen, hold } : { text: goal, doneWhen };
  }
  const said = lastUserText(messages, skip).slice(0, 400);
  if (said === "") return undefined;
  const doneWhen = "the request has been fully handled";
  // A failed derivation must not drop a restriction the user set.
  const hold = current?.hold ?? "";
  trace?.({ kind: "goal", goal: said, doneWhen, hold, previous: current?.text, fallback: true });
  return hold ? { text: said, doneWhen, hold } : { text: said, doneWhen };
}

/** The goal's hold as a line of a question (with its leading newline), or nothing. */
function holdLine(goal: Goal): string {
  return goal.hold ? `\nUser's hold, still in force: ${goal.hold}` : "";
}

/** Whether the goal has been accomplished, judged from what actually happened in the conversation. */
export async function checkGoal(
  client: Client,
  messages: Message[],
  toolDefs: Tool[],
  goal: Goal,
  signal?: AbortSignal,
  trace?: TraceSink,
): Promise<Verdict> {
  const reply = await ask(
    client,
    messages,
    toolDefs,
    `[goal check, not from the user] Goal: ${goal.text}\nDone when: ${goal.doneWhen}${holdLine(goal)}\nJudge only from what has actually happened in this conversation, not from what you intended to do. Reply with JSON. "verdict": "yes" if the goal is fully accomplished (detail: the evidence, quoting the result that proves it); "no" if there is still more to do that you can do yourself right now, within any hold (detail: the single next step); "blocked" if you cannot go on without the user, such as a decision, a confirmation before something irreversible, personal details or a login (detail: exactly what you need from them). If the next step would break the user's hold, the verdict is "blocked" and the detail names the hold and what you need from them.`,
    VERDICT_SCHEMA,
    "goal-check",
    signal,
    trace,
  );
  if (!reply.ok) return { kind: "unknown", detail: reply.why };
  // The schema allows only these three.
  const kind = reply.reply["verdict"] as "yes" | "no" | "blocked";
  return { kind, detail: text(reply.reply["detail"]) };
}

/** Whether a long-running turn is getting anywhere. */
export interface Progress {
  kind: "progressing" | "stuck";
  detail: string;
}

const PROGRESS_SCHEMA = {
  type: "object",
  properties: {
    progress: { enum: ["progressing", "stuck"] },
    detail: { type: "string" },
  },
  required: ["progress", "detail"],
  additionalProperties: false,
};

/**
 * Mid-turn: is the agent making real progress toward the goal, or repeating
 * itself, failing the same way, or going in circles? Fails open ("progressing")
 * so a broken check can never cut work short.
 */
export async function checkProgress(
  client: Client,
  messages: Message[],
  toolDefs: Tool[],
  goal: Goal,
  signal?: AbortSignal,
  trace?: TraceSink,
): Promise<Progress> {
  const reply = await ask(
    client,
    messages,
    toolDefs,
    `[progress check, not from the user] Goal: ${goal.text}
Done when: ${goal.doneWhen}
This turn has been running for a long time. Judging only from the recent tool calls and their results: is real headway being made toward the goal, or are the same steps being repeated, the same errors hit, or the work going in circles? Reply with JSON. "progress": "progressing" if each recent step moved the work forward, "stuck" if not. "detail": one sentence saying why.`,
    PROGRESS_SCHEMA,
    "progress-check",
    signal,
    trace,
  );
  const detail = reply.ok ? text(reply.reply["detail"]) : "";
  return reply.ok && reply.reply["progress"] === "stuck"
    ? { kind: "stuck", detail }
    : { kind: "progressing", detail };
}

/** The message that sends the model back to work after a "no" verdict. */
export function continueNote(goal: Goal, verdict: Verdict): string {
  const hold = goal.hold ? `\nThe user's standing restriction, which still applies: ${goal.hold}` : "";
  return `Your goal is not met yet: ${goal.text}\nNext step: ${verdict.detail}${hold}\nDo it now by calling the tool, without describing it first.`;
}
