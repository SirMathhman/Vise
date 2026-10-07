import type { Message, Result } from "../core/errors.ts";
import { formatError } from "../output/format.ts";

/**
 * Upkeep for turns that run for hundreds of tool calls. The engine calls the
 * hook this returns before each model round after the first; it keeps the
 * conversation from outgrowing the context window, saves the session as it goes
 * (so a crash after two hundred calls loses little), and every so often asks
 * whether the work is still getting somewhere.
 */

/** Save the session after this many rounds (counted across the continues of one user message). */
const SAVE_EVERY = 25;

/** Ask whether the work is making progress after this many rounds. */
const PROGRESS_EVERY = 50;

export interface RoundDeps {
  /** Compact `messages` (the turn's conversation) if the next prompt would not fit comfortably. */
  compact: (messages: Message[]) => Promise<Result<string>>;
  /** Write the session to disk. */
  save: () => Promise<void>;
  /** The goal's progress check: a reason to stop the turn, or undefined. */
  progress: () => Promise<string | undefined>;
}

/** A fresh hook for one user message: its counter spans every turn the message causes. */
export function makeRoundHook(
  deps: RoundDeps,
  /** Shows the reason a turn was stopped (the reply was streamed, so nothing else would). */
  announce?: (text: string) => void,
): (round: number, messages: Message[]) => Promise<string | undefined> {
  const hook = upkeep(deps);
  return async (round, messages) => {
    const stop = await hook(round, messages);
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
    if (rounds % SAVE_EVERY === 0) await deps.save();
    if (rounds % PROGRESS_EVERY === 0) return deps.progress();
    return undefined;
  };
}
