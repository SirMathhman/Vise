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
  /** Compact the conversation if it is getting full. */
  compact: () => Promise<unknown>;
  /** Write the session to disk. */
  save: () => Promise<void>;
  /** The goal's progress check: a reason to stop the turn, or undefined. */
  progress: () => Promise<string | undefined>;
}

/** A fresh hook for one user message: its counter spans every turn the message causes. */
export function makeRoundHook(
  deps: RoundDeps,
): (round: number) => Promise<string | undefined> {
  let rounds = 0;
  return async () => {
    rounds += 1;
    await deps.compact();
    if (rounds % SAVE_EVERY === 0) await deps.save();
    if (rounds % PROGRESS_EVERY === 0) return deps.progress();
    return undefined;
  };
}
