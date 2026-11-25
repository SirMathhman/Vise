import type { ModelSelf } from "./model-facts";

/**
 * What one reply passes to every tool it runs: the project root, and the facts about the model
 * answering. The tool loop passes this one object whole.
 */
export interface ReplyContext {
  /** The project root the tools work in. */
  root: string;
  /** The facts about the model answering the reply, for the model-info tool. */
  self?: ModelSelf;
}
