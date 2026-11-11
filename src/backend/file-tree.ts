import type { Emit } from "../protocol/protocol.ts";
import type { SessionPorts } from "./ports.ts";

// The file tree and the file viewer the page shows. Each function answers with an event and never throws;
// a failure is reported, and the session goes on.

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

// Sends the whole text of one file, for the page's file viewer. Answers true when the text was sent. A file that
// cannot be shown is reported and answers false.
export async function announceFile(ports: SessionPorts, emit: Emit, path: string): Promise<boolean> {
  if (ports.fileText === undefined) return false;
  const read = await ports.fileText(path);
  if (!read.ok) {
    emit({ kind: "error", message: `could not show ${path}: ${read.error.message}` });
    return false;
  }
  emit({ kind: "file", path, text: read.value });
  return true;
}

// Writes the text the page sent for a file, then sends the file's text back, so the page shows what was written.
export async function writeFileFor(ports: SessionPorts, emit: Emit, path: string, text: string): Promise<void> {
  if (ports.saveFile === undefined) {
    emit({ kind: "error", message: "files cannot be saved here" });
    return;
  }
  const saved = await ports.saveFile(path, text);
  if (!saved.ok) {
    emit({ kind: "error", message: `could not save ${path}: ${saved.error.message}` });
    return;
  }
  emit({ kind: "file", path, text });
}
