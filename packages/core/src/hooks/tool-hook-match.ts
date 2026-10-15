/**
 * Hooks that run around one tool call. An entry is a shell command and,
 * optionally, the tools it applies to: tool names and/or categories (`files`,
 * `shell`, `mcp_<server>`, ...). No `tools` means every tool.
 */
export interface ToolHookEntry {
  command: string;
  tools?: string[];
}

/** What a hook run decides about a call that is about to run. */
export interface PreToolVerdict {
  /** Set when a hook vetoed the call: the reason the model is shown. */
  blocked?: string;
}

/**
 * The runner's view of the tool hooks (the edge implements it with shell
 * commands). `pre` may veto a call; `post` returns text to append to the
 * result ("" for nothing).
 */
export interface ToolHooks {
  pre(
    name: string,
    category: string | undefined,
    args: Record<string, unknown>,
    depth: number,
  ): Promise<PreToolVerdict>;
  post(
    name: string,
    category: string | undefined,
    args: Record<string, unknown>,
    result: string,
    depth: number,
  ): Promise<string>;
}

/** Whether `entry` applies to the tool `name` of `category`. */
export function matchesTool(entry: ToolHookEntry, name: string, category?: string): boolean {
  const wanted = entry.tools;
  if (wanted === undefined || wanted.length === 0) return true;
  return wanted.some((w) => w === name || (category !== undefined && w === category));
}

/**
 * Read a config value (a string, an entry object, or a list of either) into
 * entries. Anything else, and entries with no command, are dropped.
 */
export function parseToolHookEntries(raw: unknown): ToolHookEntry[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: ToolHookEntry[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item.trim() !== "") out.push({ command: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const { command, tools } = item as { command?: unknown; tools?: unknown };
    if (typeof command !== "string" || command.trim() === "") continue;
    const names = Array.isArray(tools)
      ? tools.filter((t): t is string => typeof t === "string" && t !== "")
      : [];
    out.push(names.length > 0 ? { command, tools: names } : { command });
  }
  return out;
}

/** The config form of an entry: a bare string when it has no tool filter. */
export function toolHookConfig(entry: ToolHookEntry): string | ToolHookEntry {
  return entry.tools && entry.tools.length > 0
    ? { command: entry.command, tools: entry.tools }
    : entry.command;
}

/** `command (tools: a, b)` for listings. */
export function describeToolHook(entry: ToolHookEntry): string {
  return entry.tools && entry.tools.length > 0
    ? `${entry.command}  [tools: ${entry.tools.join(", ")}]`
    : entry.command;
}
