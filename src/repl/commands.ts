import type { ToolController } from "../core/engine.ts";
import type { Result } from "../core/errors.ts";
import {
  formatContext,
  formatModelList,
  formatNoteList,
  formatToolList,
} from "../output/format.ts";
import type { ContextSource, ModelController, NoteSource } from "./session.ts";

/**
 * Render `/context`. Reads the max live on every call (at most one `/slots`
 * request) and never makes a model call or pushes a message. Do not cache
 * `contextMax` across turns here: the live read is what keeps the reported
 * window accurate if the server's window changes.
 */
export function reportContext(context: ContextSource): Promise<Result<string>> {
  const max = context.contextMax();
  return max.then((m) => {
    if (!m.ok) return { ok: false as const, error: m.error };
    const used = context.lastPromptTokensUsed() ?? 0;
    return { ok: true as const, value: formatContext(used, m.value) };
  });
}

/**
 * Handle `/model` and `/model <name>`.
 * When name is omitted: lists available models from the server.
 * When name is provided: validates the name and switches the active model.
 */
export async function handleModelCommand(
  modelController: ModelController | undefined,
  line: string,
): Promise<Result<string>> {
  if (!modelController) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "model switching not supported by the current client",
      },
    };
  }

  const arg = line.slice("/model".length).trim();
  if (arg === "") {
    const models = await modelController.listModels();
    if (!models.ok) return models;
    const current = modelController.getModel();
    return {
      ok: true,
      value: formatModelList(models.value, current),
    };
  }

  const models = await modelController.listModels();
  if (!models.ok) return models;
  if (!models.value.includes(arg)) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `unknown model '${arg}'. Run '/model' to see available models.`,
      },
    };
  }

  modelController.setModel(arg);
  return { ok: true, value: `switched to model ${arg}` };
}

/**
 * Handle `/tool`, `/tool <name> enable`, and `/tool <name> disable`.
 * When no name is given: lists every tool with its current enabled state.
 * When a name and a verb are given: toggles that tool. The full set of tool
 * definitions is always sent to the model regardless of enabled state —
 * disabling a tool does not change the definitions; it only makes the
 * `ToolRunner` reject invocations of that tool. When `onToggle` is provided
 * (as the `Session` does), it is called with the new state so the model can
 * be informed the tool's enabled state changed.
 */
export function handleToolCommand(
  toolController: ToolController | undefined,
  line: string,
  onToggle?: (name: string, enabled: boolean) => void,
): Result<string> {
  if (!toolController) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "tools not supported by the current client",
      },
    };
  }

  const args = line
    .slice("/tool".length)
    .trim()
    .split(/\s+/)
    .filter((a) => a !== "");
  if (args.length === 0) {
    return { ok: true, value: formatToolList(toolController.list()) };
  }

  const [name, verb] = args as [string, string | undefined];
  if (verb !== "enable" && verb !== "disable") {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `usage: /tool <name> enable|disable`,
      },
    };
  }
  const known = toolController.list().some((t) => t.name === name);
  if (!known) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `unknown tool '${name}'. Run '/tool' to see available tools.`,
      },
    };
  }

  const enabled = verb === "enable";
  toolController.set(name, enabled);
  onToggle?.(name, enabled);
  return { ok: true, value: `${name} ${verb}d` };
}

/**
 * Handle `/note` and `/note init <name>`. When no argument: lists every
 * note with its one-line summary. When `init <name>`: creates a new note
 * with a placeholder template body. Notes are exposed to the model on
 * demand through the note tools; this command is the user's view of the
 * same store.
 */
export async function handleNotesCommand(
  noteSource: NoteSource | undefined,
  line: string,
): Promise<Result<string>> {
  if (!noteSource) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "notes not supported by the current client",
      },
    };
  }
  const arg = line.slice("/note".length).trim();
  if (arg === "") {
    const notes = await noteSource.listNotes();
    if (!notes.ok) return notes;
    return { ok: true, value: formatNoteList(notes.value) };
  }
  const sub = arg.split(" ")[0];
  if (sub === "init") {
    const name = arg.slice("init".length).trim();
    if (name === "") {
      return {
        ok: false,
        error: { kind: "malformed", body: "usage: /note init <name>" },
      };
    }
    const result = await noteSource.initNote(name);
    if (!result.ok) return result;
    return { ok: true, value: `initialized note '${name}'` };
  }
  return {
    ok: false,
    error: { kind: "malformed", body: `unknown /note subcommand '${sub}'` },
  };
}
