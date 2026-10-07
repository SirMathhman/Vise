import type { ToolController } from "../core/engine.ts";
import { REASONING_EFFORTS } from "../client/llm.ts";
import type { Result } from "../core/errors.ts";
import {
  formatContext,
  formatModelList,
  formatNoteList,
  formatReasoningList,
  formatToolList,
} from "../output/format.ts";
import type {
  ContextSource,
  ModelController,
  NoteSource,
  ReasoningController,
} from "./session.ts";

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
 * Handle `/reasoning` and `/reasoning <effort>`.
 * When no argument: lists the available levels with the active one marked.
 * When an argument is provided: validates it against the known levels and sets
 * the active level. A value of `default` clears the setting so the chat
 * template's built-in default applies.
 */
export function handleReasoningCommand(
  reasoningController: ReasoningController | undefined,
  line: string,
): Result<string> {
  if (!reasoningController) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "reasoning effort not supported by the current client",
      },
    };
  }

  const arg = line.slice("/reasoning".length).trim();
  if (arg === "") {
    const current = reasoningController.getReasoningEffort() ?? "default";
    return {
      ok: true,
      value: formatReasoningList(
        REASONING_EFFORTS as unknown as string[],
        current,
      ),
    };
  }

  const lower = arg.toLowerCase();
  const known = REASONING_EFFORTS.some((e) => e === lower);
  if (!known) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `unknown reasoning effort '${arg}'. Run '/reasoning' to see available levels.`,
      },
    };
  }

  reasoningController.setReasoningEffort(
    lower === "default" ? undefined : lower,
  );
  return {
    ok: true,
    value:
      lower === "default"
        ? "reasoning effort set to default (template default)"
        : `reasoning effort set to ${lower}`,
  };
}

/**
 * Handle `/burst`, `/burst on`, and `/burst off`: the burst-mode toggle (think
 * once to plan, then run tool calls without thinking in between). `onChange`
 * fires only when the state actually changes.
 */
export function handleBurstCommand(
  isOn: () => boolean,
  onChange: (on: boolean) => void,
  line: string,
): Result<string> {
  const arg = line.slice("/burst".length).trim().toLowerCase();
  if (arg === "")
    return { ok: true, value: `burst mode is ${isOn() ? "on" : "off"}` };
  if (arg !== "on" && arg !== "off") {
    return {
      ok: false,
      error: { kind: "malformed", body: "usage: /burst [on|off]" },
    };
  }
  const on = arg === "on";
  if (on !== isOn()) onChange(on);
  return { ok: true, value: `burst mode ${arg}` };
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
  onToggle?: (names: string[], enabled: boolean) => void,
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
  // A tool name toggles that tool; otherwise a category name toggles its whole group.
  const all = toolController.list();
  const isTool = all.some((t) => t.name === name);
  const enabled = verb === "enable";
  const names = isTool
    ? [name]
    : all.filter((t) => t.category === name).map((t) => t.name);
  if (names.length === 0) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `unknown tool '${name}'. Run '/tool' to see available tools.`,
      },
    };
  }

  for (const n of names) toolController.set(n, enabled);
  onToggle?.(names, enabled);
  return {
    ok: true,
    value: isTool
      ? `${name} ${verb}d`
      : `category '${name}' ${verb}d (${names.length} tools)`,
  };
}

/** The note telling the model that tools were enabled or disabled. */
export function toggleNotice(names: string[], enabled: boolean): string {
  if (names.length === 1) {
    return enabled
      ? `Tool '${names[0]}' is now enabled. You may call it.`
      : `Tool '${names[0]}' is now disabled. Do not call it; if asked, say it is disabled.`;
  }
  const list = names.map((n) => `'${n}'`).join(", ");
  return enabled
    ? `Tools ${list} are now enabled. You may call them.`
    : `Tools ${list} are now disabled. Do not call them; if asked, say they are disabled.`;
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
    const [name, category, ...extra] = arg
      .slice("init".length)
      .trim()
      .split(/\s+/);
    if (!name || extra.length > 0) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: "usage: /note init <name> [category]",
        },
      };
    }
    const result = await noteSource.initNote(name, category);
    if (!result.ok) return result;
    return {
      ok: true,
      value: `initialized note '${name}'${category ? ` in category '${category}'` : ""}`,
    };
  }
  return {
    ok: false,
    error: { kind: "malformed", body: `unknown /note subcommand '${sub}'` },
  };
}
