// Semantic search tool: searches the vector index for chunks whose meaning
// matches the query. The index is built at startup by llm/vectors.ts.
import type { ToolContext } from "../llm/types.ts";
import { semanticSearch } from "../llm/vectors.ts";

export const semantic_search = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> => {
  const query = String(args.query ?? "");
  if (query.length === 0) return "Error: query is empty.";
  const k = Math.max(1, Math.min(20, Number(args.k ?? 5)));
  try {
    const results = await semanticSearch(ctx.config, query, k);
    if (results.length === 0) {
      return `No matches for "${query}". The index may be empty or the query may not match any content.`;
    }
    const lines: string[] = [];
    for (const r of results) {
      lines.push(
        `${r.path} (chunk ${r.chunk}, score ${r.score.toFixed(3)}): ${r.content}`,
      );
    }
    return lines.join("\n\n");
  } catch (err) {
    return `Semantic search error: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
};
