import type { PromptProgress } from "../core/errors.ts";
import { describeCall } from "../core/progress.ts";
import { dim } from "../output/color.ts";
import { formatGoalEvent } from "../output/format.ts";
import {
  formatPicture,
  formatToolCall,
  summarizeToolResult,
} from "../output/tool-line.ts";
import { displayOfTool } from "../tools/display.ts";
import type { Picture } from "../core/errors.ts";
import type { GoalEvent } from "../repl/turn/goal-loop.ts";
import { renderLine } from "../output/markdown.ts";

/**
 * Streaming display state machine. Owns all mutable state for rendering
 * live progress counters (prompt, thinking) and streamed markdown content
 * to the terminal. The three arrow-function properties are the callbacks
 * passed to the core; they are bound to the instance so they can be
 * passed around (e.g. wrapped by the subagent handler) without losing
 * `this`.
 */
export class StreamDisplay {
  private promptActive = false;
  private lastText = "";
  private thinkingCount = 0;
  private thinkingActive = false;
  private contentWritten = false;
  private mdLineBuffer = "";
  private mdInFence = false;

  /**
   * Handle a content token from the model. Clears any active counter,
   * appends to the markdown line buffer, and renders completed lines
   * with markdown styling.
   */
  onToken = (token: string): void => {
    if (this.promptActive) {
      this.promptActive = false;
      process.stdout.write("\n");
    }
    if (this.thinkingActive) {
      this.thinkingActive = false;
      process.stdout.write("\n");
    }
    this.contentWritten = true;
    this.mdLineBuffer += token;
    // Split out completed lines and render each with markdown styling.
    let nl: number;
    while ((nl = this.mdLineBuffer.indexOf("\n")) !== -1) {
      const line = this.mdLineBuffer.slice(0, nl);
      this.mdLineBuffer = this.mdLineBuffer.slice(nl + 1);
      const [styled, newInFence] = renderLine(line, this.mdInFence);
      this.mdInFence = newInFence;
      process.stdout.write(styled + "\n");
    }
  };

  /**
   * Handle a thinking token. Increments the thinking counter and
   * overwrites the previous counter line in place.
   */
  onThinking = (_token: string): void => {
    this.thinkingCount++;
    const text = dim(`thinking: ${this.thinkingCount}`);
    if (this.thinkingActive) {
      const prev = `thinking: ${this.thinkingCount - 1}`;
      process.stdout.write("\r" + " ".repeat(prev.length + 1) + "\r" + text);
    } else {
      if (this.contentWritten) {
        this.flushMdLine();
      }
      this.thinkingActive = true;
      process.stdout.write(text);
    }
  };

  /**
   * Handle a prompt-progress update during the silent prefill. Overwrites
   * the previous counter line in place, or starts a new one.
   */
  onPromptProgress = (progress: PromptProgress): void => {
    if (progress.processed >= progress.total) {
      if (this.promptActive) {
        this.promptActive = false;
        process.stdout.write("\n");
      }
      return;
    }
    // Only the tokens this call reads (not the cached conversation), labelled by what the call is for.
    const shown = describeCall(progress) ?? "";
    const text = dim(shown);
    if (this.promptActive) {
      process.stdout.write(
        "\r" + " ".repeat(this.lastText.length + 1) + "\r" + text,
      );
    } else {
      if (this.contentWritten) {
        this.flushMdLine();
      }
      this.promptActive = true;
      process.stdout.write(text);
    }
    this.lastText = shown;
  };

  /** Show what a finished tool call came to ("12 matches") under it, when there is something to say. */
  onToolResult = (name: string, depth: number, result: string): void => {
    const summary = summarizeToolResult(name, result);
    if (summary === undefined) return;
    if (this.contentWritten) this.flushMdLine();
    process.stdout.write(dim(`${"  ".repeat(depth)}  → ${summary}`) + "\n");
  };

  /** Display a picture a tool produced as a caption (a terminal cannot show it). */
  onImage = (picture: Picture): void => {
    if (this.contentWritten) this.flushMdLine();
    process.stdout.write(dim(formatPicture(picture)) + "\n");
  };

  /** Display a tool invocation as a visible event between model rounds. */
  onToolCall = (
    name: string,
    depth = 0,
    args?: Record<string, unknown>,
  ): void => {
    if (this.promptActive) {
      this.promptActive = false;
      process.stdout.write("\n");
    }
    if (this.thinkingActive) {
      this.thinkingActive = false;
      process.stdout.write("\n");
    }
    if (this.contentWritten) this.flushMdLine();
    process.stdout.write(
      dim(`${"  ".repeat(depth)}${formatToolCall(name, args, displayOfTool)}`) +
        "\n",
    );
  };

  /** Display the goal and each verdict on it as a visible event between model rounds. */
  onGoal = (event: GoalEvent): void => {
    const line = formatGoalEvent(event);
    if (!line) return;
    if (this.promptActive || this.thinkingActive) {
      this.promptActive = false;
      this.thinkingActive = false;
      process.stdout.write("\n");
    }
    if (this.contentWritten) this.flushMdLine();
    process.stdout.write(dim(line.text) + "\n");
  };

  /** Reset all state at the start of a new user turn. */
  beginTurn(): void {
    this.promptActive = false;
    this.lastText = "";
    this.thinkingCount = 0;
    this.thinkingActive = false;
    this.contentWritten = false;
    this.mdLineBuffer = "";
    this.mdInFence = false;
  }

  /**
   * Flush any partial markdown line still buffered. Call after a streamed
   * turn completes so the last (newline-less) line is rendered.
   */
  finish(streamed: boolean): void {
    if (streamed) {
      this.flushMdLine();
    }
  }

  private flushMdLine(): void {
    if (this.mdLineBuffer.length > 0) {
      const [styled, newInFence] = renderLine(
        this.mdLineBuffer,
        this.mdInFence,
      );
      this.mdInFence = newInFence;
      this.mdLineBuffer = "";
      process.stdout.write(styled + "\n");
    }
  }
}
