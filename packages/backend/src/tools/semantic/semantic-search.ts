import { formatSemanticStatus } from "../../output/semantic-format.ts";
import type { SemanticHit, SemanticIndexPort } from "../../repl/ports.ts";
import { badNumber, numberArg } from "../args.ts";

/** Hits returned when the model does not say, and the most it may ask for. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
/** Lines of a passage shown (the model reads the file for the rest). */
const SNIPPET_LINES = 6;

/** One hit: where it is, how close, and the start of the passage. */
function formatHit(hit: SemanticHit): string {
  const body = hit.snippet
    .split("\n")
    .slice(0, SNIPPET_LINES)
    .map((line) => `    ${line.length > 160 ? `${line.slice(0, 160)}…` : line}`)
    .join("\n");
  return `${hit.path}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(2)})\n${body}`;
}

/**
 * The `semantic_search` tool: passages of the project's files closest in
 * meaning to a query. Read-only: the index is built by the user's `/embed` and
 * in the background, and a failure here is an `error:` result that says what
 * to do (usually: fall back to `search_files`).
 */
export function makeSemanticSearchHandler(index: SemanticIndexPort) {
  return async (args: Record<string, unknown>): Promise<string> => {
    const query = typeof args["query"] === "string" ? args["query"].trim() : "";
    if (query === "") return "error: 'query' is required";
    const wrong = badNumber("limit", args["limit"]);
    if (wrong) return wrong;
    const asked = numberArg(args["limit"]);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(asked ?? DEFAULT_LIMIT)));

    const status = index.status();
    if (status.state === "unavailable") {
      return `error: ${formatSemanticStatus(status)}. Use search_files (exact text) instead.`;
    }
    const hits = await index.search(query, limit);
    if (!hits.ok) return `error: ${formatSemanticStatus(index.status())}`;
    if (hits.value.length === 0) {
      const now = index.status();
      if (now.state === "indexing") {
        return `no matches yet: the index is still being built (${now.done ?? 0}/${now.total ?? 0} files). Try search_files, or ask again shortly.`;
      }
      if (now.state === "ready") return `no semantic matches for '${query}'`;
      return "error: nothing is indexed yet (it is built in the background when a folder opens; the user can run /embed). Use search_files instead.";
    }
    const done = index.status();
    const note =
      done.state === "indexing" ? `\n(the index is still being built: ${done.done ?? 0}/${done.total ?? 0} files)` : "";
    return `${hits.value.map(formatHit).join("\n")}${note}\nRead a file with read_file (offset = the first line) to see more.`;
  };
}
