import type { Emit } from "../protocol/protocol.ts";
import type { SessionPorts } from "./ports.ts";

// The file tree the page shows. Each function answers with an event and never throws; a failure is
// reported, and the session goes on.

// Sends the entries of one folder, for the page to show under it. The empty path is the working directory.
export async function announceTree(ports: SessionPorts, emit: Emit, path: string): Promise<void> {
  if (ports.tree === undefined) return;
  const listed = await ports.tree(path);
  if (!listed.ok) {
    emit({ kind: "error", message: `could not list ${path === "" ? "the folder" : path}: ${listed.error.message}` });
    return;
  }
  emit({ kind: "tree", path, entries: listed.value });
}
