import { globalDataDir } from "../../data-dir.ts";
import { NoteStore } from "../../stores/note-store.ts";
import { handleNoteMessage } from "./notes-api.ts";
import { handleWorkflowMessage } from "./workflows-api.ts";

/** Route a notes or workflow editor message to its store; null when it is neither. */
export function handleEditorMessage(
  dataDir: string,
  msg: Record<string, unknown>,
): Record<string, unknown>[] | null {
  return (
    handleNoteMessage(new NoteStore({ project: dataDir, global: globalDataDir }), msg) ??
    handleWorkflowMessage({ project: dataDir, global: globalDataDir }, msg)
  );
}
