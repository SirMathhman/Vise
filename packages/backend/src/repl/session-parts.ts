import type { Message, Result, TodoStore } from "@vise/core";
import type { GoalLog } from "@vise/core";
import { formatHelp } from "../output/format.ts";
import type { CommandNeed } from "./command-catalog.ts";
import type { LineResult, SessionSource } from "./ports.ts";

/**
 * Pure pieces of `Session` (help text, the outcome of a turn line, saving):
 * they take what they need as arguments, so the class keeps only its state
 * and the wiring between its parts.
 */

/** `/help`: the commands this session can run (`has`: what each kind of command needs, and whether it is there). */
export function helpResult(
  has: [CommandNeed, boolean][],
  web: boolean,
  hooks: { pre: number; post: number },
): LineResult {
  return {
    ok: true,
    value: formatHelp({
      available: new Set(has.filter(([, on]) => on).map(([need]) => need)),
      web,
      preTurnHookCount: hooks.pre,
      postTurnHookCount: hooks.post,
    }),
  };
}

/**
 * A finished turn line. A failed auto-compact is non-fatal: the turn ran
 * against the uncut conversation and the warning goes to the edge. `streamed`
 * tells the edge the reply was already written token by token.
 */
export function turnLineResult(reply: string, streamed: boolean, auto: Result<string>): LineResult {
  return auto.ok
    ? { ok: true, value: reply, streamed }
    : { ok: true, value: reply, streamed, compactionWarning: auto.error };
}

/** `first` on the first call, `rest` on every later one (a workflow, then plain turns under the goal). */
export function firstThen<T>(first: () => Promise<T>, rest: () => Promise<T>): () => Promise<T> {
  let started = false;
  return () => {
    if (started) return rest();
    started = true;
    return first();
  };
}

/** What a session save writes. */
export interface SaveRecord {
  id: string | undefined;
  name: string;
  messages: Message[];
  profile: string | undefined;
  todos: TodoStore | undefined;
  goalLog: GoalLog;
}

/** Save the conversation; the id it was saved under, or undefined when it was not (saving is best-effort). */
export async function saveConversation(
  source: SessionSource,
  record: SaveRecord,
): Promise<string | undefined> {
  try {
    const saved = await source.save(
      record.id,
      record.name,
      record.messages,
      record.profile,
      record.todos?.get(),
      record.goalLog.entries(),
    );
    return saved.ok ? saved.value : undefined;
  } catch {
    // A rejected edge promise must not fail a turn.
    return undefined;
  }
}

/** A conversation as it starts: the system message, then the opening context (tree, notes) when there is one. */
export function freshConversation(system: Message, initial: string | undefined): Message[] {
  return initial ? [system, { role: "user", content: initial }] : [system];
}
