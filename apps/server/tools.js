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
import { runPowershell, searchFiles } from "./processTools.js";

/**
 * A tool the model can call. Its definition (sent to the LLM) and executor
 * (run server-side) live together so the tool contract is defined exactly
 * once. Adding a tool is a single-file change.
 */


/**
 * The registry of tools available to the model. Per-domain tool modules
 * (processTools.js, evalTools.js, notesTools.js) are re-exported here so
 * the LLM sees a single registry.
 */
export const TOOLS = [
  runPowershell,
  searchFiles,
  createFunction,
  evalExpression,
  listEvalFunctions,
  takeNote,
  updateNoteTool,
  deleteNoteTool,
  recallNotes,
];
