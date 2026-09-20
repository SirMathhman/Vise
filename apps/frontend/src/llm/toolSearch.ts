import type { LlmTool } from "../api/client.js";

/**
 * The pure half of `search_tools`: matching tool definitions against a query
 * and formatting the result for the model. No DOM, no network, so it is
 * testable on its own; the tool-call plumbing lives in components/llm.ts.
 */

/** The most matches one search returns; a broader query is told to narrow. */
export const MAX_SEARCH_RESULTS = 8;

/**
 * The tools matching `query`, best first. `select:a,b` returns exactly those
 * names (in that order). Otherwise every whitespace-separated word must
 * appear (case-insensitively) in the tool's name or description, and tools
 * with more of the words in their *name* rank first, then by list order. If
 * no tool has every word (a natural-language query full of filler), fall back
 * to tools matching any word, most matching words first.
 */
export function matchTools(defs: LlmTool[], query: string): LlmTool[] {
  const q = query.trim();
  if (q.toLowerCase().startsWith("select:")) {
    const names = q
      .slice("select:".length)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    return names
      .map((n) =>
        defs.find((d) => d.function.name.toLowerCase() === n.toLowerCase())
      )
      .filter((d): d is LlmTool => d !== undefined);
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = defs.map((d, order) => {
    const name = d.function.name.toLowerCase();
    const haystack = `${name} ${d.function.description.toLowerCase()}`;
    return {
      d,
      order,
      found: words.filter((w) => haystack.includes(w)).length,
      inName: words.filter((w) => name.includes(w)).length,
    };
  });
  const all = scored.filter((r) => r.found === words.length);
  const pool = all.length > 0 ? all : scored.filter((r) => r.found > 0);
  return pool
    .sort(
      (a, b) => b.found - a.found || b.inName - a.inName || a.order - b.order
    )
    .map((r) => r.d);
}

/**
 * The model-readable result of a search: each match's name, whether it is
 * already loaded or must go through call_tool, its description, and its
 * parameter schema (which is what the model needs to call it correctly).
 */
export function formatToolSearch(
  matches: LlmTool[],
  deferred: ReadonlySet<string>,
  query: string
): string {
  if (matches.length === 0) {
    return `No tools matched "${query}". Try fewer or different keywords, or "select:name" for an exact tool name.`;
  }
  const shown = matches.slice(0, MAX_SEARCH_RESULTS);
  const blocks = shown.map((t) => {
    const how = deferred.has(t.function.name)
      ? "run with call_tool"
      : "already loaded: call it directly";
    return (
      `${t.function.name} (${how})\n` +
      `${t.function.description}\n` +
      `parameters: ${JSON.stringify(t.function.parameters)}`
    );
  });
  const more =
    matches.length > shown.length
      ? `\n\n(${matches.length - shown.length} more matched; narrow the query to see them.)`
      : "";
  return blocks.join("\n\n") + more;
}
