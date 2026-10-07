import type { Tool } from "../core/engine.ts";

/**
 * Tool search. Most tools are "deferred": the system prompt lists only their
 * name and a one-line summary, and the model fetches the full signature with
 * `search_tools` when it needs one. No separate "call tool" tool is needed:
 * calls are parsed from the model's text and the per-request grammar already
 * allows every enabled tool by name, deferred or not. The signatures arrive
 * as a tool result, so the (cached) system prompt never changes.
 */

/** Always-visible tools; everything else is deferred. */
const CORE_TOOLS = new Set([
  "list_directory",
  "read_file",
  "create_file",
  "edit_file",
  "delete_file",
  "find_files",
  "search_files",
  "run_powershell",
  "ask_user",
  "search_tools",
]);

const MAX_RESULTS = 5;

export const searchToolsDef: Tool = {
  type: "function",
  function: {
    name: "search_tools",
    description:
      "Look up the full signature of a deferred tool. The system prompt lists deferred tools by name with a one-line summary only; call this with a keyword (e.g. 'browser click'), a category name from the index (e.g. 'browser', returns that whole group), or exact tool names (comma-separated), then call the tool you found exactly like any other. Returns up to 5 matches.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keywords to match against tool names and descriptions, or exact tool names separated by commas",
        },
      },
      required: ["query"],
    },
  },
};

/** Flag every tool outside the core set as deferred (it keeps all its other fields). */
export function deferTools(defs: Tool[]): Tool[] {
  return defs.map((t) =>
    CORE_TOOLS.has(t.function.name) ? t : { ...t, deferred: true },
  );
}

/** Rank tools by keyword hits: a name hit counts three times a description hit. */
function rank(defs: Tool[], query: string): Tool[] {
  const words = query
    .toLowerCase()
    .split(/[\s,_]+/)
    .filter(Boolean);
  const scored = defs
    .map((t) => {
      const name = t.function.name.toLowerCase();
      const text = t.function.description.toLowerCase();
      const score = words.reduce(
        (sum, w) =>
          sum + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0),
        0,
      );
      return { t, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS).map((s) => s.t);
}

/**
 * Edge handler for `search_tools`. Exact names (comma-separated) select those
 * tools directly; anything else is a keyword search. Results use the same JSON
 * signature format as the system prompt, and note when a tool is disabled.
 */
export function makeSearchToolsHandler(
  defs: Tool[],
  isEnabled: (name: string) => boolean,
): (args: Record<string, unknown>) => string {
  return (args) => {
    const query = args["query"];
    if (typeof query !== "string" || query.trim() === "") {
      return "error: search_tools requires a non-empty 'query' argument";
    }
    const names = query.split(",").map((n) => n.trim());
    const exact = defs.filter((t) => names.includes(t.function.name));
    // A bare category name returns the whole group.
    const group = defs.filter((t) => t.category === query.trim().toLowerCase());
    const found =
      exact.length > 0 ? exact : group.length > 0 ? group : rank(defs, query);
    if (found.length === 0) return `no tools match "${query}"`;
    return found
      .map(
        (t) =>
          JSON.stringify(t.function) +
          (isEnabled(t.function.name) ? "" : "  (currently disabled)"),
      )
      .join("\n");
  };
}
