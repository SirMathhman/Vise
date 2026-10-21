import type { AskRequest, UserPrompter } from "@vise/backend";

/**
 * Edge implementation of UserPrompter over a WebSocket. When the model calls
 * `ask_user` (or the max-tool-rounds callback fires), it sends an `ask`
 * message to the browser and awaits the `ask_answer` reply. `ask_user` and
 * max-rounds never overlap within a turn, so a single pending slot is safe.
 */
export class WebUserPrompter implements UserPrompter {
  private pending: ((answer: string) => void) | null = null;
  constructor(private readonly send: (msg: Record<string, unknown>) => void) {}

  ask({ question, options, descriptions, multiSelect = false }: AskRequest): Promise<string> {
    this.send({ type: "ask", question, options, descriptions, multiSelect });
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  /**
   * Stop: the turn no longer waits for an answer (its wait is raced against the
   * stop signal), so close the question on the page and drop the pending slot.
   */
  cancel(): void {
    if (!this.pending) return;
    this.settle("");
    this.send({ type: "ask_cancel" });
  }

  /** Resolve the pending ask with the user's reply; no-op when none is open. */
  settle(answer: string): void {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve(answer);
    }
  }
}
