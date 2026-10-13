import { config } from "../../config.ts";
import type { Client, Tool } from "@vise/core";
import type { Message, Result } from "@vise/core";
import {
  checkGoal,
  checkProgress,
  continueNote,
  deriveGoal,
  type Goal,
} from "@vise/core";
import {
  capTrace,
  type ExitReason,
  type GoalLog,
  type TraceSink,
} from "@vise/core";
import { formatError } from "../../output/format.ts";
import { formatGoalTrace } from "../../output/goal-trace-format.ts";

/**
 * Runs each user turn against a goal (see `src/core/goal.ts`): the goal is set
 * when the user speaks and kept across turns until it is met; when the model
 * stops, it is asked whether the goal was accomplished, and sent back to work
 * until it says yes, or says it is blocked on the user. The session owns one
 * tracker; the edge shows the events it emits.
 */

/** What the edge is told so it can show the goal and each verdict. */
export type GoalEvent =
  | { kind: "goal"; goal: string; doneWhen: string; hold?: string }
  | {
      kind: "verdict";
      verdict: "yes" | "no" | "blocked" | "unknown";
      detail: string;
      /** A "no" that is sending the model back to work. */
      continuing: boolean;
    }
  | { kind: "setting"; enabled: boolean };

/** What the tracker needs from its surroundings while it loops. */
export interface GoalHooks {
  /** Ask the user whether to keep going after many continues; without it the turn stops there. */
  confirmMore?: (question: string) => Promise<boolean>;
  /** Run before each continue (the session compacts a conversation that is getting full). */
  beforeContinue?: () => Promise<unknown>;
}

/** What the user last said (the tracker's own continue notes do not count). */
function lastUserLine(
  messages: Message[],
  isNote: (m: Message) => boolean,
): string {
  const last = [...messages]
    .reverse()
    .find((m) => m.role === "user" && !isNote(m));
  return last?.content ?? "";
}

const toolResults = (messages: Message[]): number =>
  messages.filter((m) => m.role === "tool").length;

/** How a turn's goal loop ended, and why (the trace's `exit` entry). */
interface Ended {
  turn: Result<string>;
  reason: ExitReason;
  detail?: string;
}

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
    /** Told every decision and hidden call, for the saved goal trace. */
    private readonly trace?: TraceSink,
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
      this.trace,
    );
    if (progress.kind !== "stuck") {
      this.trace?.({
        kind: "progress",
        progress: progress.kind,
        detail: progress.detail,
      });
      return undefined;
    }
    const why = progress.detail || "the same steps keep repeating";
    // One model opinion must not end the user's task: repetitive work (paging, scrolling) can be right.
    const keepGoing = await ask?.(
      `This does not seem to be getting anywhere: ${why} Keep going?`,
    );
    this.trace?.({
      kind: "progress",
      progress: "stuck",
      detail: why,
      keepGoing: keepGoing === true,
    });
    if (keepGoing) return undefined;
    this.halted = why;
    return `Stopped: this does not seem to be getting anywhere. ${why}`;
  }

  /** End the turn the progress check stopped: tell the edge, and keep the goal for the user's reply. */
  private halt(turn: Result<string>): Ended {
    const why = this.halted;
    this.block(
      `${why} (the work was stopped because it was not getting anywhere)`,
    );
    this.halted = undefined;
    return { turn, reason: "halted-progress", detail: why };
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
    this.trace?.({ kind: "setting", enabled: value });
    this.emit?.({ kind: "setting", enabled: value });
  }

  /**
   * Run a turn under the goal. `runTurn` performs one model-and-tools turn
   * over `messages`; it is called again, after a note pushed onto `messages`,
   * for as long as the model says the goal is not met and keeps making
   * progress. With goal checking off it is just `runTurn`. Every decision, and
   * the one reason the loop ended, goes to the trace.
   */
  async run(
    client: Client,
    messages: Message[],
    toolDefs: Tool[],
    runTurn: () => Promise<Result<string>>,
    signal: AbortSignal,
    hooks: GoalHooks = {},
  ): Promise<Result<string>> {
    const start = messages.length;
    this.trace?.({
      kind: "turn_start",
      line: capTrace(lastUserLine(messages, this.isNote)),
      enabled: this.on,
      goal: this.goal?.text,
    });
    let ended: Ended;
    try {
      ended = await this.loop(client, messages, toolDefs, runTurn, signal, hooks);
    } catch (err) {
      this.exit(messages, start, "exception", String(err));
      throw err;
    }
    this.exit(messages, start, ended.reason, ended.detail);
    return ended.turn;
  }

  /** Write the turn's single `exit` entry. */
  private exit(
    messages: Message[],
    start: number,
    reason: ExitReason,
    detail?: string,
  ): void {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    this.trace?.({
      kind: "exit",
      reason,
      detail,
      lastReply: capTrace((last?.content ?? "").slice(0, 600)),
      toolResults: toolResults(messages.slice(start)),
    });
  }

  /** Work out the goal for the user's latest message and tell the edge. */
  private async setGoal(
    client: Client,
    messages: Message[],
    toolDefs: Tool[],
    signal: AbortSignal,
  ): Promise<void> {
    this.goal = await deriveGoal(
      client,
      messages,
      toolDefs,
      this.goal,
      signal,
      this.isNote,
      this.trace,
    );
    if (this.goal && !signal.aborted) {
      const { text, doneWhen, hold } = this.goal;
      this.emit?.({ kind: "goal", goal: text, doneWhen, ...(hold ? { hold } : {}) });
    }
  }

  /** After many automatic continues the user is asked whether to keep going; false means stop (and tell the edge why). */
  private async mayGoOn(
    hooks: GoalHooks,
    continues: number,
    detail: string,
  ): Promise<boolean> {
    if (continues === 0 || continues % config.continuesBeforeAsking !== 0) {
      return true;
    }
    const more =
      (await hooks.confirmMore?.(
        `The goal still is not met after ${continues} automatic continues. Keep going?`,
      )) ?? false;
    if (!more) {
      this.block(`${detail} (stopped after ${continues} automatic continues)`);
    }
    return more;
  }

  /** Push the note that sends the model back to work (not the user's words: never saved or summarised) and trace it. */
  private sendBack(
    messages: Message[],
    content: string,
    counters: { continues: number; repeats: number; toolsRan: boolean },
  ): void {
    const note: Message = { role: "user", content };
    this.notes.add(note);
    messages.push(note);
    this.trace?.({ kind: "continue", note: capTrace(content), ...counters });
  }

  private async loop(
    client: Client,
    messages: Message[],
    toolDefs: Tool[],
    runTurn: () => Promise<Result<string>>,
    signal: AbortSignal,
    hooks: GoalHooks,
  ): Promise<Ended> {
    const interrupted: Ended = {
      turn: { ok: false, error: { kind: "interrupted" } },
      reason: "interrupted",
    };
    if (!this.on) return { turn: await runTurn(), reason: "goal-off" };
    this.halted = undefined;
    await this.setGoal(client, messages, toolDefs, signal);
    if (signal.aborted) return interrupted;
    // The tool results before the turn: what "tools ran since" is measured from.
    let results = toolResults(messages);
    let turn = await runTurn();
    if (this.halted !== undefined) return this.halt(turn);
    let step = "";
    let repeats = 0;
    let continues = 0;
    while (turn.ok && this.goal) {
      const verdict = await checkGoal(
        client,
        messages,
        toolDefs,
        this.goal,
        signal,
        this.trace,
      );
      this.trace?.({
        kind: "verdict",
        verdict: verdict.kind,
        detail: verdict.detail,
      });
      if (signal.aborted) return interrupted;
      if (verdict.kind !== "no") {
        this.emit?.({
          ...verdict,
          kind: "verdict",
          verdict: verdict.kind,
          continuing: false,
        });
        if (verdict.kind === "yes") this.goal = undefined;
        return {
          turn,
          reason: verdict.kind === "yes" ? "met" : verdict.kind,
          detail: verdict.detail,
        };
      }
      // The same step again with nothing done in between means it is going nowhere.
      const sameStep = verdict.detail === step;
      repeats = sameStep ? repeats + 1 : 0;
      const idle = toolResults(messages) === results;
      if (sameStep && (idle || repeats >= config.maxSameStep)) {
        this.block(
          `${verdict.detail} (it is not getting anywhere with this step)`,
        );
        return { turn, reason: "same-step", detail: verdict.detail };
      }
      if (!(await this.mayGoOn(hooks, continues, verdict.detail))) {
        return {
          turn,
          reason: "max-continues-declined",
          detail: `${continues} automatic continues; ${verdict.detail}`,
        };
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
      this.sendBack(messages, continueNote(this.goal, verdict), {
        continues,
        repeats,
        toolsRan: !idle,
      });
      turn = await runTurn();
      if (this.halted !== undefined) return this.halt(turn);
    }
    if (!turn.ok) {
      return {
        turn,
        reason: signal.aborted ? "interrupted" : "turn-failed",
        detail: formatError(turn.error),
      };
    }
    return { turn, reason: "no-goal" };
  }
}

/** `/goal` (status), `/goal on|off`, `/goal clear`. */
export function handleGoalCommand(
  tracker: GoalTracker,
  line: string,
  log?: GoalLog,
): Result<string> {
  const arg = line.slice("/goal".length).trim().toLowerCase();
  // `/goal log [turns]`: every goal decision of this conversation and why each turn ended.
  const logArg = /^log(?:\s+(\d+))?$/.exec(arg);
  if (logArg && log) {
    const turns = logArg[1] === undefined ? undefined : Number(logArg[1]);
    return { ok: true, value: formatGoalTrace(log.entries(), turns) };
  }
  if (arg === "") {
    const state = `goal checking is ${tracker.enabled ? "on" : "off"}`;
    const goal = tracker.goal;
    return {
      ok: true,
      value: goal
        ? `${state}\ncurrent goal: ${goal.text}\ndone when: ${goal.doneWhen}${goal.hold ? `\nhold: ${goal.hold}` : ""}`
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
    error: { kind: "malformed", body: "usage: /goal [on|off|clear|log [turns]]" },
  };
}
