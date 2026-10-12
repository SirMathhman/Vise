import type { SemanticHit, SemanticStatus, SemanticUpdateStats } from "../repl/ports.ts";

/** One line saying what the index holds and what it is doing. */
export function formatSemanticStatus(status: SemanticStatus): string {
  const files = `${status.files} file${status.files === 1 ? "" : "s"}, ${status.chunks} passages`;
  switch (status.state) {
    case "indexing":
      return `indexing: ${status.done ?? 0}/${status.total ?? 0} files (${files} so far, model ${status.model})`;
    case "ready":
      return `index ready: ${files} (model ${status.model})`;
    case "unavailable":
      return `semantic search is unavailable: ${status.reason ?? "the embedding model cannot be used"}`;
    default:
      return status.reason ? `nothing indexed yet: ${status.reason}` : "nothing indexed yet (run /embed)";
  }
}

/** What an update did, as a sentence. */
export function formatUpdateStats(stats: SemanticUpdateStats): string {
  const parts = [`${stats.indexed} indexed`, `${stats.skipped} unchanged or skipped`];
  if (stats.removed > 0) parts.push(`${stats.removed} removed`);
  if (stats.failed > 0) parts.push(`${stats.failed} failed`);
  return parts.join(", ");
}

/** A score as two decimals: precision a ranking does not have. */
const score = (hit: SemanticHit): string => hit.score.toFixed(2);

/** The hits of a search as `path:lines  score` rows each followed by the start of the passage. */
export function formatSemanticHits(query: string, hits: SemanticHit[], status: SemanticStatus): string {
  if (hits.length === 0) {
    const empty =
      status.state === "indexing"
        ? `no matches yet for '${query}'; ${formatSemanticStatus(status)}`
        : status.state === "ready"
          ? `no semantic matches for '${query}'`
          : formatSemanticStatus(status);
    return empty;
  }
  const rows = hits.map((hit) => {
    const where = `${hit.path}:${hit.startLine}-${hit.endLine}`;
    const body = hit.snippet
      .split("\n")
      .slice(0, 3)
      .map((line) => `    ${line.length > 110 ? `${line.slice(0, 110)}…` : line}`)
      .join("\n");
    return `${where}  (${score(hit)})\n${body}`;
  });
  const note = status.state === "indexing" ? `\n(still indexing: ${status.done ?? 0}/${status.total ?? 0} files)` : "";
  return `${rows.join("\n")}${note}`;
}
