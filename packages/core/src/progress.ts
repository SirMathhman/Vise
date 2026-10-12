import type { CallPurpose, PromptProgress } from "./errors.ts";

const NAMES: Record<CallPurpose, string> = {
  reply: "prompt",
  goal: "goal",
  "goal-check": "goal check",
  "progress-check": "progress check",
  compaction: "compaction",
  workflow: "workflow",
  subagent: "subagent",
};

/**
 * What one model call is reading. A prompt is mostly the conversation so far,
 * which the server already holds in its cache; what the call costs is the part
 * that is new. So the counts here are of that new part only: `total` is the
 * tokens this call has to read, `done` how many it has read, `reused` how many
 * came free from the cache.
 */
export interface CallReading {
  /** What the call is for ("prompt" for the reply itself, "goal check", "compaction"...). */
  name: string;
  total: number;
  done: number;
  reused: number;
  finished: boolean;
}

/** The reading for a progress report, or undefined when it carries no prompt size. */
export function readCall(progress: PromptProgress): CallReading | undefined {
  if (progress.total <= 0) return undefined;
  const processed = Math.min(Math.max(progress.processed, 0), progress.total);
  const reused = Math.min(
    Math.max(progress.cache, 0),
    processed || progress.total,
  );
  return {
    name: NAMES[progress.purpose ?? "reply"],
    total: progress.total - reused,
    done: Math.max(processed - reused, 0),
    reused,
    finished: processed >= progress.total,
  };
}

/** The one-line text: `goal check: 1200/4800 tokens` while reading, `goal check: 4800 tokens · 512 reused · 3.2 s` when done. */
export function describeCall(progress: PromptProgress): string | undefined {
  const reading = readCall(progress);
  if (!reading) return undefined;
  const reused = reading.reused > 0 ? ` · ${reading.reused} reused` : "";
  if (!reading.finished) {
    return `${reading.name}: ${reading.done}/${reading.total} tokens${reused}`;
  }
  return `${reading.name}: ${reading.total} tokens${reused} · ${(progress.time_ms / 1000).toFixed(1)} s`;
}
