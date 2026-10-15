import type { ToolController } from "@vise/core";
import type { WorkflowProfiles } from "@vise/core";
import type { ProfileCommands } from "../ports.ts";
import { handleProfileCommand } from "./session-commands.ts";

/** What a workflow run gets for switching profiles, and how to put the profile you had back. */
export interface WorkflowProfileScope {
  /** Undefined when the session has no profile source. */
  profiles: WorkflowProfiles | undefined;
  /** The profile active now (to restore after the run). */
  active: string | undefined;
  /** The profile active at this moment (it differs from `active` once a profile step ran). */
  current(): string | undefined;
  /** Put `before` back: it becomes the active profile and its tool list applies again. */
  restore(before: string | undefined): Promise<void>;
}

/**
 * The profile side of a workflow run, over the same machinery as `/profile`.
 * `flush` moves a switch's queued messages into the conversation at once,
 * because a workflow's steps run without waiting for the next turn.
 */
export function workflowProfileScope(
  commands: ProfileCommands,
  controller: ToolController | undefined,
  flush: () => void,
): WorkflowProfileScope {
  const source = commands.profileSource();
  const tools = async (name: string) =>
    name !== "default" && source?.profileTools
      ? source.profileTools(name)
      : ({ ok: true, value: undefined } as const);
  return {
    active: commands.activeProfile(),
    current: () => commands.activeProfile(),
    profiles: source && {
      async apply(name) {
        const result = await handleProfileCommand(commands, `/profile ${name}`);
        flush();
        return result;
      },
      tools,
      enabled: () =>
        controller
          ?.list()
          .filter((t) => t.enabled)
          .map((t) => t.name) ?? [],
      baseline: () =>
        controller
          ?.list()
          .filter((t) => controller.baselineEnabled?.(t.name) ?? t.enabled)
          .map((t) => t.name) ?? [],
    },
    async restore(before) {
      commands.setActiveProfile(before);
      const whitelist = before === undefined ? undefined : await tools(before);
      commands.applyProfileTools(whitelist?.ok ? whitelist.value : undefined);
    },
  };
}
