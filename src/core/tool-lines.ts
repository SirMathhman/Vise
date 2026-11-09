import type { ToolCall } from "./messages.ts";
import { notePath, scaffold } from "./notes.ts";
import {
  ASK_USER,
  CREATE_FILE,
  CREATE_NOTE,
  EDIT_FILE,
  KILL_COMMAND,
  LIST_FILES,
  READ_COMMAND,
  READ_FILE,
  RUN_POWERSHELL,
  RUN_SUBAGENT,
  parseAskArgs,
  parseCreateFileArgs,
  parseCreateNoteArgs,
  parseEditFileArgs,
  parseJobArgs,
  parseListFilesArgs,
  parseReadFileArgs,
  parseRunPowershellArgs,
  parseSubagentArgs,
  isExternalName,
} from "./tools.ts";

// Edits, new files, and commands are run or written only after the user approves them.
export function needsApproval(call: ToolCall): boolean {
  return (
    call.name === EDIT_FILE ||
    call.name === CREATE_FILE ||
    call.name === CREATE_NOTE ||
    call.name === RUN_POWERSHELL ||
    call.name === KILL_COMMAND ||
    isExternalName(call.name)
  );
}

// The change or command shown to the user before they approve it. Undefined when the arguments are
// invalid, in which case the tool reports that without writing or running anything.
export function approvalPreview(call: ToolCall): string | undefined {
  if (call.name === EDIT_FILE) {
    const args = parseEditFileArgs(call.arguments);
    if (!args.ok) return undefined;
    return `edit ${args.value.path}\n--- previous\n${args.value.previous}\n+++ replacement\n${args.value.replacement}`;
  }
  if (call.name === CREATE_FILE) {
    const args = parseCreateFileArgs(call.arguments);
    if (!args.ok) return undefined;
    return `create ${args.value.path}\n+++ content\n${args.value.content}`;
  }
  if (call.name === CREATE_NOTE) {
    const args = parseCreateNoteArgs(call.arguments);
    if (!args.ok) return undefined;
    const { category, name } = args.value;
    return `create ${notePath(category, name)}\n+++ content\n${scaffold(category, name)}`;
  }
  if (call.name === RUN_POWERSHELL) {
    const args = parseRunPowershellArgs(call.arguments);
    if (!args.ok) return undefined;
    return `run in the working directory\n$ ${args.value.command}`;
  }
  if (call.name === KILL_COMMAND) {
    const args = parseJobArgs(call.arguments);
    if (!args.ok) return undefined;
    return `stop background job ${args.value.job}`;
  }
  if (isExternalName(call.name)) {
    return `call ${call.name}
+++ arguments
${call.arguments}`;
  }
  return undefined;
}

// Replaces control characters, except tab and newline, so model text cannot move or
// overwrite the terminal's output when it is shown.
export function sanitize(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    const control = (code < 32 && code !== 9 && code !== 10) || code === 127;
    return control ? "?" : char;
  }).join("");
}

// The line shown to the user when the model makes a call.
export function describeToolCall(call: ToolCall): string {
  if (call.name === LIST_FILES) {
    const args = parseListFilesArgs(call.arguments);
    if (!args.ok) return `tool: ${LIST_FILES} (invalid arguments)`;
    return `tool: ${LIST_FILES} ${args.value.path} depth ${args.value.depth}`;
  }
  if (call.name === READ_FILE) {
    const args = parseReadFileArgs(call.arguments);
    if (!args.ok) return `tool: ${READ_FILE} (invalid arguments)`;
    return `tool: ${READ_FILE} ${args.value.path} lines ${args.value.start}-${args.value.end}`;
  }
  if (call.name === EDIT_FILE) {
    const args = parseEditFileArgs(call.arguments);
    if (!args.ok) return `tool: ${EDIT_FILE} (invalid arguments)`;
    return `tool: ${EDIT_FILE} ${args.value.path}`;
  }
  if (call.name === CREATE_FILE) {
    const args = parseCreateFileArgs(call.arguments);
    if (!args.ok) return `tool: ${CREATE_FILE} (invalid arguments)`;
    return `tool: ${CREATE_FILE} ${args.value.path}`;
  }
  if (call.name === CREATE_NOTE) {
    const args = parseCreateNoteArgs(call.arguments);
    if (!args.ok) return `tool: ${CREATE_NOTE} (invalid arguments)`;
    return `tool: ${CREATE_NOTE} ${notePath(args.value.category, args.value.name)}`;
  }
  if (call.name === RUN_POWERSHELL) {
    const args = parseRunPowershellArgs(call.arguments);
    if (!args.ok) return `tool: ${RUN_POWERSHELL} (invalid arguments)`;
    return `tool: ${RUN_POWERSHELL} ${args.value.command.split("\n")[0]}`;
  }
  if (call.name === READ_COMMAND || call.name === KILL_COMMAND) {
    const args = parseJobArgs(call.arguments);
    if (!args.ok) return `tool: ${call.name} (invalid arguments)`;
    return `tool: ${call.name} job ${args.value.job}`;
  }
  if (call.name === RUN_SUBAGENT) {
    const args = parseSubagentArgs(call.arguments);
    if (!args.ok) return `tool: ${RUN_SUBAGENT} (invalid arguments)`;
    return `tool: ${RUN_SUBAGENT} ${args.value.profile} up to ${args.value.maxToolCalls} tool calls`;
  }
  if (call.name === ASK_USER) {
    const args = parseAskArgs(call.arguments);
    if (!args.ok) return `tool: ${ASK_USER} (invalid arguments)`;
    return `tool: ${ASK_USER} ${args.value.question}`;
  }
  if (isExternalName(call.name)) return `tool: ${call.name} (server tool)`;
  return `tool: ${call.name} (unknown tool)`;
}

// What the user answered an ask_user question with: the choices picked, and a line typed of their own.
export interface AskReply {
  chosen: string[];
  text: string;
}

// The reply for picks given by position (0 is the first choice). A position outside the list is ignored,
// and a choice picked twice counts once.
export function askReplyOf(choices: string[], picked: number[], text: string): AskReply {
  const chosen: string[] = [];
  for (const index of picked) {
    const choice = choices[index];
    if (choice !== undefined && !chosen.includes(choice)) chosen.push(choice);
  }
  return { chosen, text: text.trim() };
}

// Reads one line typed as the answer. Numbers separated by commas or spaces pick the choices they name, from 1
// to the count; any other line is the user's own answer.
export function parseAskLine(line: string, choices: string[]): AskReply {
  const words = line.trim().split(/[\s,]+/).filter((word) => word !== "");
  const numbers = words.every((word) => /^\d+$/.test(word));
  const inRange = words.every((word) => Number(word) >= 1 && Number(word) <= choices.length);
  if (words.length > 0 && numbers && inRange) {
    return askReplyOf(choices, words.map((word) => Number(word) - 1), "");
  }
  return { chosen: [], text: line.trim() };
}

// The result the model gets for an answered ask_user call.
export function askResultText(reply: AskReply): string {
  const parts: string[] = [];
  if (reply.chosen.length > 0) parts.push(`the user chose: ${reply.chosen.join(", ")}`);
  if (reply.text !== "") parts.push(`the user answered: ${reply.text}`);
  return parts.length === 0 ? "the user gave no answer" : parts.join("; ");
}
