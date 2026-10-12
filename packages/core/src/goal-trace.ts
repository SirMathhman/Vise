/**
 * The goal trace: a record of every decision the goal machinery makes while a
 * conversation runs, kept with the saved session so that "why did this
 * conversation stop although a goal was set?" can be answered afterwards. It
 * holds what the user never sees: the hidden questions and the model's raw
 * answers, the continue notes, and the reason each turn's goal loop ended.
 *
 * Pure data and an in-memory log; storage is the edge's job.
 */

/** Why the goal loop of one turn ended. */
export type ExitReason =
  | "goal-off"
  | "no-goal"
  | "met"
  | "blocked"
  | "unknown"
  | "same-step"
  | "max-continues-declined"
  | "halted-progress"
  | "turn-failed"
  | "interrupted"
  | "exception";

/** One fact about the goal machinery, without the bookkeeping the log adds. */
export type GoalTraceFact =
  | { kind: "setting"; enabled: boolean }
  | { kind: "turn_start"; line: string; enabled: boolean; goal?: string }
  | {
      kind: "ask";
      purpose: string;
      attempt: number;
      question: string;
      /** The model's raw reply; absent when the call failed. */
      reply?: string;
      /** Why the call failed or its reply was unusable. */
      failure?: string;
    }
  | {
      kind: "goal";
      goal: string;
      doneWhen: string;
      previous?: string;
      /** The goal is the user's own words because the derivation failed or said nothing. */
      fallback: boolean;
    }
  | { kind: "verdict"; verdict: string; detail: string }
  | {
      kind: "progress";
      progress: string;
      detail: string;
      /** The user's answer to "keep going?", when a stuck work was put to them. */
      keepGoing?: boolean;
    }
  | {
      kind: "continue";
      note: string;
      continues: number;
      repeats: number;
      /** Whether any tool ran since the previous continue. */
      toolsRan: boolean;
    }
  | {
      kind: "exit";
      reason: ExitReason;
      detail?: string;
      /** The start of the model's last reply: usually the clue to why it stopped. */
      lastReply: string;
      toolResults: number;
    };

/** A fact as stored: when it happened and how long the conversation was then. */
export type GoalTraceEntry = GoalTraceFact & {
  at: string;
  /** The number of messages in the conversation when it was recorded. */
  after: number;
};

/** The longest text kept for a question, reply or note. */
export const TRACE_TEXT_MAX = 4000;

/** `text` cut to `TRACE_TEXT_MAX` characters, saying so when it was cut. */
export function capTrace(text: string): string {
  return text.length <= TRACE_TEXT_MAX
    ? text
    : `${text.slice(0, TRACE_TEXT_MAX)}… (${text.length - TRACE_TEXT_MAX} more characters)`;
}

/** What the core functions call to report a fact. */
export type TraceSink = (fact: GoalTraceFact) => void;

/** Where the session keeps the trace: read when saving, replaced on resume and `/new`. */
export class GoalLog {
  private items: GoalTraceEntry[] = [];

  /** `size` tells how many messages the conversation has now; `now` is the clock. */
  constructor(
    private readonly size: () => number = () => 0,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  add = (fact: GoalTraceFact): void => {
    this.items.push({ ...fact, at: this.now(), after: this.size() });
  };

  entries(): GoalTraceEntry[] {
    return [...this.items];
  }

  set(entries: GoalTraceEntry[]): void {
    this.items = [...entries];
  }

  clear(): void {
    this.items = [];
  }
}
