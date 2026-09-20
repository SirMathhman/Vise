import type { LlmTool, LlmToolCall } from "../api/client.js";
import type { AskQuestion } from "../components/askQuestionsCard.js";
import { formatToolSearch, matchTools } from "./toolSearch.js";
import {
  DEFERRED_TOOL_NAMES,
  isMetaTool,
  llmToolDefinitions,
  offeredToolDefinitions,
} from "./tools.js";

/**
 * The pure half of tool-call handling: parsing a tool call's arguments,
 * deciding what a profile may use, and the search_tools / call_tool logic.
 * No DOM, no network and no store, so all of it is testable on its own; the
 * side-effecting dispatch (running a tool, a subagent, a question card) lives
 * in components/llm.ts's resolveToolCall.
 */

/** Model-readable result returned when the active profile doesn't allow a tool. */
export function disabledToolResult(name: string, profileName: string): string {
  return (
    `${name} is not available in the "${profileName}" profile. Do not call ` +
    "it; if you need its capability, tell the user to add it to the " +
    "profile's allowed tools."
  );
}

/**
 * Every known tool name that `allowed` does not include. The meta-tools
 * (search_tools, call_tool) are never disabled: they grant nothing themselves,
 * since a search only lists allowed tools and call_tool re-checks the target.
 */
export function disabledFromAllowed(allowed: string[]): string[] {
  return llmToolDefinitions
    .map((t) => t.function.name)
    .filter((name) => !allowed.includes(name) && !isMetaTool(name));
}

/**
 * The definitions to send with a request under a profile whose disabled tools
 * are `disabled`: the loaded tools, and the meta-tools only if at least one
 * deferred tool is allowed (otherwise they would cost schema tokens and lead
 * nowhere).
 */
export function offeredToolsFor(disabled: string[]): LlmTool[] {
  const anyDeferred = DEFERRED_TOOL_NAMES.some((n) => !disabled.includes(n));
  return offeredToolDefinitions.filter(
    (t) => anyDeferred || !isMetaTool(t.function.name)
  );
}

/**
 * The tool definitions offered to a subagent: llmToolDefinitions filtered to
 * the profile's `allowed` tools, always excluding the client-executed tools a
 * headless subagent cannot fulfil — create_subagent (so a subagent can never
 * spawn further subagents), ask_questions (its collapsed transcript has no
 * room for an interactive card, and its loop has no way to pause for a user),
 * use_skill (the skill store is a panel concern; a subagent's loop has no way
 * to look one up, since it calls executeLlmTool directly rather than
 * resolveToolCall), and the search_tools/call_tool meta-tools (also
 * client-executed, and unneeded: a subagent is offered every allowed tool
 * directly, deferred ones included). All are excluded regardless of what the
 * profile's own allowed list happens to say.
 */
export function subagentToolDefs(allowed: string[]): LlmTool[] {
  return llmToolDefinitions.filter(
    (t) =>
      t.function.name !== "create_subagent" &&
      t.function.name !== "ask_questions" &&
      t.function.name !== "use_skill" &&
      !isMetaTool(t.function.name) &&
      allowed.includes(t.function.name)
  );
}

/** Parse a tool call's JSON arguments into an object, or undefined if they aren't one. */
export function parseJsonObject(
  json: string
): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(json || "{}");
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the `task`/`profile` arguments out of a create_subagent tool call. */
export function parseSubagentArgs(tc: LlmToolCall): {
  task: string;
  profile: string;
} {
  try {
    const args = JSON.parse(tc.function.arguments) as {
      task?: unknown;
      profile?: unknown;
    };
    return {
      task: typeof args.task === "string" ? args.task : "",
      profile: typeof args.profile === "string" ? args.profile : "",
    };
  } catch {
    return { task: "", profile: "" };
  }
}

/** Parse the `name` argument out of a use_skill tool call. */
export function parseUseSkillArgs(tc: LlmToolCall): string | undefined {
  try {
    const args = JSON.parse(tc.function.arguments) as { name?: unknown };
    return typeof args.name === "string" && args.name !== ""
      ? args.name
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the `questions` argument out of an ask_questions tool call. */
export function parseAskQuestionsArgs(tc: LlmToolCall): AskQuestion[] {
  try {
    const args = JSON.parse(tc.function.arguments) as {
      questions?: unknown;
    };
    if (!Array.isArray(args.questions)) return [];
    const out: AskQuestion[] = [];
    for (const q of args.questions) {
      if (typeof q !== "object" || q === null) continue;
      const o = q as Record<string, unknown>;
      if (typeof o.question !== "string") continue;
      const item: AskQuestion = { question: o.question };
      if (Array.isArray(o.options)) {
        item.options = (o.options as unknown[]).filter(
          (v): v is string => typeof v === "string"
        );
      }
      if (typeof o.multi_select === "boolean") {
        item.multiSelect = o.multi_select;
      }
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

/** The result of search_tools: the allowed tools matching the query (meta-tools excluded). */
export function searchToolsResult(tc: LlmToolCall, allowed: string[]): string {
  const query = parseJsonObject(tc.function.arguments)?.query;
  if (typeof query !== "string" || !query.trim()) {
    return 'search_tools requires a `query` argument: keywords to match against tool names and descriptions, or "select:name1,name2".';
  }
  const searchable = llmToolDefinitions.filter(
    (t) => !isMetaTool(t.function.name) && allowed.includes(t.function.name)
  );
  return formatToolSearch(
    matchTools(searchable, query),
    new Set(DEFERRED_TOOL_NAMES),
    query
  );
}

/**
 * Turn a call_tool call into the call it stands for (same id, the named tool,
 * its arguments), or a model-readable error string. Only deferred tools can be
 * run this way: a loaded tool is called directly (which also keeps its
 * client-side handling, such as edit_file's live diff, keyed on the real
 * name), and the meta-tools can't be nested. The caller re-dispatches the
 * result through the normal path, so the profile check and each tool's own
 * handling apply unchanged.
 */
export function parseCallToolArgs(tc: LlmToolCall): LlmToolCall | string {
  const args = parseJsonObject(tc.function.arguments);
  if (!args) {
    return 'call_tool takes a JSON object: {"name": "<tool>", "arguments": {...}}.';
  }
  const target = typeof args.name === "string" ? args.name : "";
  if (!target) {
    return "call_tool requires a `name` argument: the exact name of the tool to run. Use search_tools to find it.";
  }
  if (isMetaTool(target)) {
    return `${target} cannot be run through call_tool; call it directly.`;
  }
  if (!llmToolDefinitions.some((t) => t.function.name === target)) {
    return `No tool named "${target}". Use search_tools to find the right name.`;
  }
  if (!DEFERRED_TOOL_NAMES.includes(target)) {
    return `${target} is already loaded; call it directly instead of through call_tool.`;
  }
  const inner = args.arguments;
  const extra = Object.keys(args).filter(
    (k) => k !== "name" && k !== "arguments"
  );
  if (inner === undefined && extra.length > 0) {
    return `call_tool takes {"name", "arguments"}: put ${target}'s parameters inside an "arguments" object (found stray keys: ${extra.join(", ")}).`;
  }
  let argJson = "{}";
  if (typeof inner === "string") {
    if (!parseJsonObject(inner)) {
      return `call_tool's "arguments" must be an object of ${target}'s parameters.`;
    }
    argJson = inner;
  } else if (inner !== undefined) {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      return `call_tool's "arguments" must be an object of ${target}'s parameters.`;
    }
    argJson = JSON.stringify(inner);
  }
  return {
    id: tc.id,
    type: "function",
    function: { name: target, arguments: argJson },
  };
}

/**
 * The call to actually resolve for `tc`: for call_tool, the call it stands
 * for (or a model-readable error string); for anything else, `tc` itself.
 */
export function unwrapCallTool(tc: LlmToolCall): LlmToolCall | string {
  return tc.function.name === "call_tool" ? parseCallToolArgs(tc) : tc;
}
