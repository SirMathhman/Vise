import {
  createFunction,
  evalExpression,
  listEvalFunctions,
} from "./evalTools.js";
import {
  takeNote,
  updateNoteTool,
  deleteNoteTool,
  recallNotes,
} from "./notesTools.js";

/**
 * A tool the model can call. Its definition (sent to the LLM) and executor
 * (run server-side) live together so the tool contract is defined exactly
 * once. Adding a tool is a single-file change.
 *
 * Note: `run_powershell` and `search_files` are not standalone tools. They are
 * exposed only as built-in functions inside the eval sandbox (see
 * `EVAL_BUILTINS` in evalTools.js) and are listed under "eval functions" in
 * the UI.
 */

/**
 * The registry of tools available to the model. Per-domain tool modules
 * (evalTools.js, notesTools.js) are re-exported here so
 * the LLM sees a single registry.
 */
export const TOOLS = [
  createFunction,
  evalExpression,
  listEvalFunctions,
  takeNote,
  updateNoteTool,
  deleteNoteTool,
  recallNotes,
];
