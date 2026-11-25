import type { ModelSelf } from "./model-facts";

/**
 * Runs one subagent on a task and returns its final text. Set by the tool loop for the main reply
 * only; a subagent's own tools get none, so a subagent cannot start another.
 */
export type SubagentRunner = (task: string) => Promise<string>;

/**
 * What one reply passes to every tool it runs: the project root, the facts about the model
 * answering, and the subagent runner when the reply may start subagents. The tool loop passes
 * this one object whole.
 */
export interface ReplyContext {
  /** The project root the tools work in. */
  root: string;
  /** The facts about the model answering the reply, for the model-info tool. */
  self?: ModelSelf;
  /** Starts a subagent, when the reply may start one. */
  subagent?: SubagentRunner;
}
