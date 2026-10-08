import { config } from "../config.ts";
import type { Client, Tool } from "../core/engine.ts";
import type { Message, Result } from "../core/errors.ts";
import {
  checkGoal,
  checkProgress,
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

/** After this many automatic continues in one turn, the user is asked whether to go on. */

/** What the tracker needs from its surroundings while it loops. */
export interface GoalHooks {
  /** Ask the user whether to keep going after many continues; without it the turn stops there. */
  confirmMore?: (question: string) => Promise<boolean>;
  /** Run before each continue (the session compacts a conversation that is getting full). */
  beforeContinue?: () => Promise<unknown>;
}

const toolResults = (messages: Message[]): number =>
  messages.filter((m) => m.role === "tool").length;

export class GoalTracker {
  goal: Goal | undefined;
  private on: boolean;
  /** Set when a mid-turn progress check found the work stuck: the turn is over and no verdict follows. */
  private halted: string | undefined;
  /** The notes this tracker added to push the model back to work: not the user's words, so never saved or summarised. */
  private readonly notes = new WeakSet<Message>();

  constructor(
    enabled: boolean,
    private readonly emit?: (event: GoalEvent) => void,
  ) {
    this.on = enabled;
  }

  /**
   * Mid-turn: is the work getting anywhere? Returns the reason to stop the turn
   * when it is not (and remembers it, so `run` ends the turn instead of judging
   * it); undefined to carry on, or when there is no goal to measure against.
   */
  async progress(
    client: Client,
    messages: Message[],
    toolDefs: Tool[],
    signal: AbortSignal,
    ask?: (question: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    if (!this.on || !this.goal) return undefined;
    const progress = await checkProgress(
      client,
      messages,
      toolDefs,
      this.goal,
      signal,
    );
    if (progress.kind !== "stuck") return undefined;
    const why = progress.detail || "the same steps keep repeating";
    // One model opinion must not end the user's task: repetitive work (paging, scrolling) can be right.
    const keepGoing = await ask?.(
      `This does not seem to be getting anywhere: ${why} Keep going?`,
    );
    if (keepGoing) return undefined;
    this.halted = why;
    return `Stopped: this does not seem to be getting anywhere. ${why}`;
  }

  /** End the turn the progress check stopped: tell the edge, and keep the goal for the user's reply. */
  private halt(turn: Result<string>): Result<string> {
    this.block(
      `${this.halted} (the work was stopped because it was not getting anywhere)`,
    );
    this.halted = undefined;
    return turn;
  }

  /** Tell the edge the turn ends because the user is needed (or the work is going nowhere). */
  private block(detail: string): void {
    this.emit?.({
      kind: "verdict",
      verdict: "blocked",
      detail,
      continuing: false,
    });
  }

  /** Whether a message is one of the tracker's own continue notes. */
  isNote = (message: Message): boolean => this.notes.has(message);

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
    hooks: GoalHooks = {},
  ): Promise<Result<string>> {
    const interrupted: Result<string> = {
      ok: false,
      error: { kind: "interrupted" },
    };
    if (!this.on) return runTurn();
    this.halted = undefined;
    this.goal = await deriveGoal(
      client,
      messages,
      toolDefs,
      this.goal,
      signal,
      this.isNote,
    );
    if (signal.aborted) return interrupted;
    if (this.goal) {
      this.emit?.({
        kind: "goal",
        goal: this.goal.text,
        doneWhen: this.goal.doneWhen,
      });
    }
    let turn = await runTurn();
    if (this.halted !== undefined) return this.halt(turn);
    let step = "";
    let repeats = 0;
    let results = toolResults(messages);
    let continues = 0;
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
      if (sameStep && (idle || repeats >= config.maxSameStep)) {
        this.block(
          `${verdict.detail} (it is not getting anywhere with this step)`,
        );
        return turn;
      }
      if (continues > 0 && continues % config.continuesBeforeAsking === 0) {
        const more =
          (await hooks.confirmMore?.(
            `The goal still is not met after ${continues} automatic continues. Keep going?`,
          )) ?? false;
        if (!more) {
          this.block(
            `${verdict.detail} (stopped after ${continues} automatic continues)`,
          );
          return turn;
        }
      }
      continues += 1;
      step = verdict.detail;
      results = toolResults(messages);
      this.emit?.({
        kind: "verdict",
        verdict: "no",
        detail: verdict.detail,
        continuing: true,
      });
      await hooks.beforeContinue?.();
      const note: Message = {
        role: "user",
        content: continueNote(this.goal, verdict),
      };
      this.notes.add(note);
      messages.push(note);
      turn = await runTurn();
      if (this.halted !== undefined) return this.halt(turn);
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
