import { globalDataDir } from "@vise/backend";
import { NoteStore } from "@vise/backend";
import { handleNoteMessage } from "./notes-api.ts";
import { handleProfileMessage } from "./profiles-api.ts";
import { handleWorkflowMessage } from "./workflows-api.ts";

/** Route a notes, workflow or profile editor message to its store; null when it is none of them. */
export function handleEditorMessage(
  dataDir: string,
  msg: Record<string, unknown>,
): Record<string, unknown>[] | null {
  return (
    handleNoteMessage(new NoteStore({ project: dataDir, global: globalDataDir }), msg) ??
    handleWorkflowMessage({ project: dataDir, global: globalDataDir }, msg) ??
    handleProfileMessage(dataDir, msg)
  );
}
