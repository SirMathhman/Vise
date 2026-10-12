import type { ToolController } from "@vise/core";
import type { Message, Result } from "@vise/core";
import type { ProfileSource } from "./ports.ts";

/**
 * Applies a profile's tool whitelist to the `ToolController`. Entering a
 * whitelisted profile enables only the listed tools and remembers what was
 * enabled before; leaving it (a profile without a whitelist, or clearing the
 * profile) restores those remembered states. Switching between two
 * whitelisted profiles keeps the original snapshot. The model is told about
 * each change with an appended user message, never by editing the prompt.
 */
export class ProfileToolGate {
  private snapshot: Map<string, boolean> | undefined;

  constructor(
    private readonly controller: ToolController | undefined,
    private readonly push: (message: Message) => void,
  ) {}

  /** Names of every known tool. */
  names(): string[] {
    return this.controller?.list().map((t) => t.name) ?? [];
  }

  /** Enable only `tools`, or (undefined) restore the remembered states. */
  apply(tools: string[] | undefined): void {
    const controller = this.controller;
    if (!controller) return;
    if (tools === undefined) {
      if (!this.snapshot) return;
      const before = enabledSet(controller);
      for (const [name, enabled] of this.snapshot)
        controller.set(name, enabled);
      this.snapshot = undefined;
      controller.setBaseline?.(undefined);
      this.push({
        role: "user",
        content: `The profile's tool restriction was lifted. ${changeNote(before, controller)}`,
      });
      return;
    }
    const before = enabledSet(controller);
    this.snapshot ??= new Map(
      controller.list().map((t) => [t.name, t.enabled]),
    );
    controller.setBaseline?.(this.snapshot);
    const allowed = new Set(tools);
    for (const t of controller.list())
      controller.set(t.name, allowed.has(t.name));
    this.push({
      role: "user",
      content: `This profile restricts tools. ${changeNote(before, controller)} All other tools are disabled; do not call them.`,
    });
  }
}

function enabledSet(controller: ToolController): Set<string> {
  return new Set(controller.list().filter((t) => t.enabled).map((t) => t.name));
}

/**
 * What a change of tools means for the model: what it can call now, what it
 * gained (with a pointer to `search_tools`, since a tool the system prompt lists
 * only by name has to be looked up before it can be used well) and what it lost.
 */
export function changeNote(before: Set<string>, controller: ToolController): string {
  const now = enabledSet(controller);
  const gained = [...now].filter((n) => !before.has(n));
  const lost = [...before].filter((n) => !now.has(n));
  const parts = [`Enabled tools: ${enabledNames(controller)}.`];
  if (gained.length > 0) {
    parts.push(`Newly available: ${gained.join(", ")} (use search_tools to see how to call any of them).`);
  }
  if (lost.length > 0) parts.push(`No longer available: ${lost.join(", ")}.`);
  return parts.join(" ");
}

function enabledNames(controller: ToolController): string {
  const names = controller
    .list()
    .filter((t) => t.enabled)
    .map((t) => t.name);
  return names.length === 0 ? "(none)" : names.join(", ");
}

/**
 * Validate and save a profile's tool whitelist (`undefined` clears it). Only
 * the profile file is written: the live conversation and tool states are
 * untouched, so editing a profile that is in use changes nothing until it is
 * switched to again. Shared by the `/profile <name> tools` command and the web
 * server's direct (unqueued) save.
 */
export async function saveProfileWhitelist(
  source: ProfileSource,
  knownTools: string[],
  name: string,
  tools: string[] | undefined,
): Promise<Result<string[] | undefined>> {
  if (!source.setProfileTools) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "tool whitelists not supported by the current client",
      },
    };
  }
  const unknown = (tools ?? []).filter((t) => !knownTools.includes(t));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `unknown tool(s): ${unknown.join(", ")}`,
      },
    };
  }
  const saved = await source.setProfileTools(name, tools);
  return saved.ok ? { ok: true, value: tools } : saved;
}
