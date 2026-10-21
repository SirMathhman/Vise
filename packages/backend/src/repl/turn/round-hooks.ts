import { config } from "../../config.ts";
import type { Message, Result } from "@vise/core";
import { formatError } from "../../output/format.ts";

/**
 * Upkeep for turns that run for hundreds of tool calls. The engine calls the
 * hook this returns before each model round after the first; it keeps the
 * conversation from outgrowing the context window, saves the session as it goes
 * (so a crash after two hundred calls loses little), and every so often asks
 * whether the work is still getting somewhere.
 */

/** Save the session after this many rounds (counted across the continues of one user message). */

/** Ask whether the work is making progress after this many rounds. */

export interface RoundDeps {
  /** Compact `messages` (the turn's conversation) if the next prompt would not fit comfortably. */
  compact: (messages: Message[]) => Promise<Result<string>>;
  /** Write the session to disk. */
  save: () => Promise<void>;
  /** The goal's progress check (`quiet`: rounds since a file last changed): a reason to stop the turn, or undefined. */
  progress: (quiet?: number) => Promise<string | undefined>;
  /** Whether a tool changes files (`Tool.writes`); without it the turn is never judged by its lack of edits. */
  writes?: (toolName: string) => boolean;
}

/** How many rounds ago a file was last changed, counting from the start of the conversation when none was. */
export function roundsSinceWrite(
  messages: Message[],
  writes: (toolName: string) => boolean,
): number {
  let rounds = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    if (m.tool_calls.some((c) => writes(c.function.name))) return rounds;
    rounds += 1;
  }
  return rounds;
}

/** The note that pushes a model that has only been reading towards its first edit. */
export function noWriteNote(quiet: number): string {
  return `[note, not from the user] ${quiet} rounds have passed without changing any file. If the task is to change files, stop researching: make the first edit now, the largest part first, and refine after.`;
}

/**
 * Things the user did that the model should know about (a tab they shared),
 * collected as they happen and added to the conversation at a safe moment: at
 * the start of a turn, or between rounds, never between a tool call and its result.
 */
export class NoticeQueue {
  private items: Message[] = [];

  /** Messages the user sent to steer a running turn; they join the conversation like any notice. */
  private steers = new Set<Message>();

  add(text: string): void {
    this.items.push({ role: "user", content: text });
  }

  steer(message: Message): void {
    this.items.push(message);
    this.steers.add(message);
  }

  drainInto(messages: Message[]): void {
    messages.push(...this.items.splice(0));
    this.steers.clear();
  }

  /** Steering messages no round picked up (the turn ended first), removed from the queue so the caller can run them as turns of their own. */
  takeSteers(): Message[] {
    const left = this.items.filter((m) => this.steers.has(m));
    this.items = this.items.filter((m) => !this.steers.has(m));
    this.steers.clear();
    return left;
  }
}

/** A fresh hook for one user message: its counter spans every turn the message causes. */
export function makeRoundHook(
  deps: RoundDeps,
  /** Shows the reason a turn was stopped (the reply was streamed, so nothing else would). */
  announce?: (text: string) => void,
  /** Added to the conversation before each round. */
  notices?: NoticeQueue,
): (round: number, messages: Message[]) => Promise<string | undefined> {
  const hook = upkeep(deps);
  return async (round, messages) => {
    notices?.drainInto(messages);
    const stop = await hook(round, messages);
    if (stop === undefined && notices && deps.writes && config.noWriteRounds > 0) {
      const quiet = roundsSinceWrite(messages, deps.writes);
      if (quiet >= config.noWriteRounds && quiet % config.noWriteRounds === 0) {
        notices.add(noWriteNote(quiet));
        notices.drainInto(messages);
      }
    }
    if (stop !== undefined)
      announce?.(`
${stop}
`);
    return stop;
  };
}

function upkeep(
  deps: RoundDeps,
): (round: number, messages: Message[]) => Promise<string | undefined> {
  let rounds = 0;
  return async (_round, messages) => {
    rounds += 1;
    const compacted = await deps.compact(messages);
    // Going on with a conversation that cannot be shrunk would only overflow the window.
    if (!compacted.ok) {
      return `Stopped: the conversation is too big for the model and could not be compacted (${formatError(compacted.error)}).`;
    }
    if (rounds % config.saveEvery === 0) await deps.save();
    const limit = config.noWriteRounds;
    const quiet = deps.writes && limit > 0 ? roundsSinceWrite(messages, deps.writes) : 0;
    const stalled = limit > 0 && quiet >= limit && quiet % limit === 0;
    if (rounds % config.progressEvery === 0 || stalled) return deps.progress(stalled ? quiet : 0);
    return undefined;
  };
}
