import { err, ok, type Result } from "./messages.ts";
import type { ToolSpec } from "./tools.ts";

// The most tools one search returns. A search that matches more returns these, and the model narrows it.
export const SEARCH_LIMIT = 20;

// The tools whose name or description holds every word of the query, ignoring case, in the order given.
export function searchTools(specs: ToolSpec[], query: string): ToolSpec[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [];
  return specs
    .filter((spec) => {
      const text = `${spec.function.name} ${spec.function.description}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, SEARCH_LIMIT);
}

// The fields a search call holds.
interface SearchFields {
  query?: unknown;
}

// The query a search call sends: the text of its query field.
export function parseSearchQuery(raw: string): Result<string> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return err(new Error("the arguments are not JSON"));
  }
  const query = (value as SearchFields | null)?.query;
  return typeof query === "string" ? ok(query) : err(new Error("query must be text"));
}
