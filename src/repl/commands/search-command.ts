import type { Result } from "../../core/errors.ts";
import { formatSearchHits } from "../../output/audit-format.ts";
import { formatSemanticHits, formatSemanticStatus, formatUpdateStats } from "../../output/semantic-format.ts";
import type { SemanticIndexPort, SessionCommands } from "../ports.ts";
import { unsupported } from "./registry.ts";

/** `/search <text>`: the saved sessions whose messages mention the text. */
export async function handleSearchCommand(
  session: SessionCommands,
  line: string,
): Promise<Result<string>> {
  const text = line.slice("/search".length).trim();
  const source = session.sessionSource();
  if (text === "" || !source?.search) {
    const body =
      text === "" ? "usage: /search <text>" : "searching is not supported here";
    return { ok: false, error: { kind: "malformed", body } };
  }
  const hits = await source.search(text);
  return hits.ok ? { ok: true, value: formatSearchHits(hits.value) } : hits;
}

/** `/search <text>` searches saved sessions; `/search semantic <text>` searches the folder's files by meaning. */
export function handleSearch(
  session: SessionCommands,
  semantic: SemanticIndexPort | undefined,
  line: string,
): Promise<Result<string>> {
  return /^\/search\s+semantic(\s|$)/.test(line)
    ? handleSemanticSearch(semantic, line)
    : handleSearchCommand(session, line);
}

/** `/search semantic <text>`: the passages of the folder's files closest in meaning to the text. */
async function handleSemanticSearch(
  index: SemanticIndexPort | undefined,
  line: string,
): Promise<Result<string>> {
  if (!index) return unsupported("semantic search (this session has no folder)");
  const query = line.replace(/^\/search\s+semantic/, "").trim();
  if (query === "") {
    return { ok: false, error: { kind: "malformed", body: "usage: /search semantic <text>" } };
  }
  const hits = await index.search(query, 8);
  if (!hits.ok) return hits;
  return { ok: true, value: formatSemanticHits(query, hits.value, index.status()) };
}

/**
 * `/embed`: bring the index up to date (what changed since it was last built);
 * `/embed status`: only say what it holds; `/embed rebuild`: throw it away and
 * embed everything again (after changing the embedding model).
 */
export async function handleEmbed(
  index: SemanticIndexPort | undefined,
  line: string,
): Promise<Result<string>> {
  if (!index) return unsupported("semantic search (this session has no folder)");
  const arg = line.slice("/embed".length).trim();
  if (arg === "status" || index.status().state === "indexing") {
    return { ok: true, value: formatSemanticStatus(index.status()) };
  }
  if (arg !== "" && arg !== "rebuild") {
    return { ok: false, error: { kind: "malformed", body: "usage: /embed [status|rebuild]" } };
  }
  const done = await index.update({ rebuild: arg === "rebuild" });
  if (!done.ok) return done;
  return { ok: true, value: `${formatUpdateStats(done.value)}. ${formatSemanticStatus(index.status())}` };
}
