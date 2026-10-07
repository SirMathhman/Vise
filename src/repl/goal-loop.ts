import type { Client, Tool } from "../core/engine.ts";
import type { Message, Result } from "../core/errors.ts";
import {
  checkGoal,
  continueNote,
  deriveGoal,
  type Goal,
} from "../core/goal.ts";

/**
 * Runs each user turn against a goal (see `src/core/goal.ts`): the goal is set
 * when the user speaks and kept across turns until it is met; when the model
 * stops, it is asked whether the goal was accomplished, and sent back to work
 * until it says yes, or says it is blocked on the user. The session owns one
 * tracker; the edge shows the events it emits.
 */

/** What the edge is told so it can show the goal and each verdict. */
export type GoalEvent =
  | { kind: "goal"; goal: string; doneWhen: string }
  | {
      kind: "verdict";
      verdict: "yes" | "no" | "blocked";
      detail: string;
      /** A "no" that is sending the model back to work. */
      continuing: boolean;
    }
  | { kind: "setting"; enabled: boolean };

/** The same unmet step this many times in a row ends the turn as blocked. */
const MAX_SAME_STEP = 4;

const toolResults = (messages: Message[]): number =>
  messages.filter((m) => m.role === "tool").length;

export class GoalTracker {
  goal: Goal | undefined;
  private on: boolean;

  constructor(
    enabled: boolean,
    private readonly emit?: (event: GoalEvent) => void,
  ) {
    this.on = enabled;
  }

  get enabled(): boolean {
    return this.on;
  }

  set enabled(value: boolean) {
    if (value === this.on) return;
    this.on = value;
    this.emit?.({ kind: "setting", enabled: value });
  }

  /**
   * Run a turn under the goal. `runTurn` performs one model-and-tools turn
   * over `messages`; it is called again, after a note pushed onto `messages`,
   * for as long as the model says the goal is not met and keeps making
   * progress. With goal checking off it is just `runTurn`.
   */
  async run(
    client: Client,
    messages: Message[],
    toolDefs: Tool[],
    runTurn: () => Promise<Result<string>>,
    signal: AbortSignal,
  ): Promise<Result<string>> {
    const interrupted: Result<string> = {
      ok: false,
      error: { kind: "interrupted" },
    };
    if (!this.on) return runTurn();
    this.goal = await deriveGoal(client, messages, toolDefs, this.goal, signal);
    if (signal.aborted) return interrupted;
    if (this.goal) {
      this.emit?.({
        kind: "goal",
        goal: this.goal.text,
        doneWhen: this.goal.doneWhen,
      });
    }
    let turn = await runTurn();
    let step = "";
    let repeats = 0;
    let results = toolResults(messages);
    while (turn.ok && this.goal) {
      const verdict = await checkGoal(
        client,
        messages,
        toolDefs,
        this.goal,
        signal,
      );
      if (signal.aborted) return interrupted;
      if (verdict.kind !== "no") {
        this.emit?.({
          ...verdict,
          kind: "verdict",
          verdict: verdict.kind,
          continuing: false,
        });
        if (verdict.kind === "yes") this.goal = undefined;
        return turn;
      }
      // The same step again with nothing done in between means it is going nowhere.
      const sameStep = verdict.detail === step;
      repeats = sameStep ? repeats + 1 : 0;
      const idle = toolResults(messages) === results;
      if (sameStep && (idle || repeats >= MAX_SAME_STEP)) {
        this.emit?.({
          kind: "verdict",
          verdict: "blocked",
          detail: `${verdict.detail} (it is not getting anywhere with this step)`,
          continuing: false,
        });
        return turn;
      }
      step = verdict.detail;
      results = toolResults(messages);
      this.emit?.({
        kind: "verdict",
        verdict: "no",
        detail: verdict.detail,
        continuing: true,
      });
      messages.push({
        role: "user",
        content: continueNote(this.goal, verdict),
      });
      turn = await runTurn();
    }
    return turn;
  }
}

/** `/goal` (status), `/goal on|off`, `/goal clear`. */
export function handleGoalCommand(
  tracker: GoalTracker,
  line: string,
): Result<string> {
  const arg = line.slice("/goal".length).trim().toLowerCase();
  if (arg === "") {
    const state = `goal checking is ${tracker.enabled ? "on" : "off"}`;
    const goal = tracker.goal;
    return {
      ok: true,
      value: goal
        ? `${state}\ncurrent goal: ${goal.text}\ndone when: ${goal.doneWhen}`
        : `${state}\nno current goal`,
    };
  }
  if (arg === "on" || arg === "off") {
    tracker.enabled = arg === "on";
    return { ok: true, value: `goal checking ${arg}` };
  }
  if (arg === "clear") {
    tracker.goal = undefined;
    return { ok: true, value: "goal cleared" };
  }
  return {
    ok: false,
    error: { kind: "malformed", body: "usage: /goal [on|off|clear]" },
  };
}
