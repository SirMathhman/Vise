import type { SemanticIndexPort } from "@vise/backend";
import { formatError } from "@vise/backend";
import { str, type Reply } from "../wire/reply.ts";

/**
 * The file explorer's semantic search, answered at once and never queued
 * behind a turn:
 *   browser → server: { type:"sem_search", query, limit? }
 *                     { type:"sem_status" }
 *                     { type:"sem_rebuild" }
 *   server → browser: { type:"sem_results", query, hits:[{ path, startLine, endLine, score, snippet }], status }
 *                     { type:"sem_results", query, error, status }
 *                     { type:"sem_status", status | null }   (null: this session has no folder to index)
 * `sem_status` is also pushed whenever the index's state changes (progress,
 * finished, failed).
 */
export async function handleSemanticMessage(
  index: SemanticIndexPort | undefined,
  msg: Record<string, unknown>,
): Promise<Reply[]> {
  if (!index) return [{ type: "sem_status", status: null }];
  const type = msg["type"];
  if (type === "sem_status") return [{ type: "sem_status", status: index.status() }];
  if (type === "sem_rebuild") {
    // It runs on; the page follows its progress through the status pushes.
    void index.update({ rebuild: true });
    return [{ type: "sem_status", status: index.status() }];
  }
  if (type === "sem_search") {
    const query = str(msg["query"]).trim();
    if (query === "") return [{ type: "sem_results", query, hits: [], status: index.status() }];
    const asked = Number(msg["limit"]);
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 25) : 12;
    const found = await index.search(query, limit);
    if (!found.ok) {
      return [
        { type: "sem_results", query, error: formatError(found.error), status: index.status() },
      ];
    }
    return [{ type: "sem_results", query, hits: found.value, status: index.status() }];
  }
  return [];
}
