import type { Result } from "../core/errors.ts";
import { formatSearchHits } from "../output/audit-format.ts";
import type { SessionCommands } from "./ports.ts";

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
