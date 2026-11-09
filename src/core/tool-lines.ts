import type { ToolCall } from "./messages.ts";
import { notePath, scaffold } from "./notes.ts";
import {
  CREATE_FILE,
  CREATE_NOTE,
  EDIT_FILE,
  KILL_COMMAND,
  LIST_FILES,
  READ_COMMAND,
  READ_FILE,
  RUN_POWERSHELL,
  RUN_SUBAGENT,
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
  if (isExternalName(call.name)) return `tool: ${call.name} (server tool)`;
  return `tool: ${call.name} (unknown tool)`;
}
