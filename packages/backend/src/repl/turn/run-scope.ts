import { abortable, abortableResult, INTERRUPTED, type Result } from "@vise/core";
import type { LineResult } from "../ports.ts";

/**
 * One line's work (a turn, a workflow or a command) and the way to stop it.
 * Every line gets a scope before anything else happens, so there is never a
 * moment in which Stop has nothing to abort; every wait of the line goes
 * through `wait`, which ends the moment the line is stopped, whatever the work
 * underneath does; and work the line stopped waiting for checks `live` before
 * it changes the conversation, so a late result is never applied.
 */
export class RunScope {
  private readonly controller = new AbortController();
  private ended = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Still the line in flight and not stopped. */
  live(): boolean {
    return !this.ended && !this.controller.signal.aborted;
  }

  stop(): void {
    this.controller.abort();
  }

  end(): void {
    this.ended = true;
  }

  /** Wait for `work`, or until the line is stopped. */
  wait<T>(work: Promise<T> | T): Promise<Result<T>> {
    return abortable(this.signal, work);
  }

  /** Wait for a `Result`, or until the line is stopped (then it is `interrupted`). */
  waitResult<T>(work: Promise<Result<T>> | Result<T>): Promise<Result<T>> {
    return abortableResult(this.signal, work);
  }

  /** Wait for a line's outcome, or until the line is stopped. */
  async waitLine(work: Promise<LineResult> | LineResult): Promise<LineResult> {
    const raced = await this.wait(work);
    return raced.ok ? raced.value : INTERRUPTED;
  }
}

/** The session's line in flight, if any: begun and ended by `Session.handleLine` alone. */
export class RunScopes {
  private scope: RunScope | null = null;

  get current(): RunScope | null {
    return this.scope;
  }

  begin(): RunScope {
    this.scope = new RunScope();
    return this.scope;
  }

  end(scope: RunScope): void {
    scope.end();
    if (this.scope === scope) this.scope = null;
  }

  /** Stop the line in flight; false when none is running. */
  interrupt(): boolean {
    this.scope?.stop();
    return this.scope !== null;
  }
}
