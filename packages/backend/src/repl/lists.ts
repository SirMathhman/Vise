import type { ToolController } from "@vise/core";
import { REASONING_EFFORTS } from "@vise/core";
import type { ProfileSource, ReasoningController, SessionSource } from "./ports.ts";

/** The built-in profile every session can switch to (it has no file). */
const DEFAULT_PROFILE = "default";

/**
 * What a frontend's controls show, as data: the profile choices, the tools
 * with their states, the reasoning levels, the saved sessions and whether
 * burst mode is on. A page reads this instead of sending `/profile`, `/tool`,
 * `/reasoning` and `/resume` and parsing the prose answers. A list that could
 * not be read is left out (`errors` says why) and the page keeps what it had.
 */
export interface ListsSnapshot {
  profiles?: { names: string[]; active: string | null };
  tools?: { name: string; enabled: boolean; category?: string }[];
  reasoning?: { levels: readonly string[]; active: string };
  sessions?: { id: string; name: string; updated?: string }[];
  burst: boolean;
  errors: string[];
}

/** The live pieces a snapshot reads (all optional: a frontend may lack a feature). */
export interface ListsSources {
  profileSource?: ProfileSource;
  activeProfile: string | undefined;
  toolController?: ToolController;
  reasoning?: ReasoningController;
  sessionSource?: SessionSource;
  burst: boolean;
}

/** Read every list now (each on its own: one failing leaves the others). */
export async function collectLists(sources: ListsSources): Promise<ListsSnapshot> {
  const snapshot: ListsSnapshot = { burst: sources.burst, errors: [] };
  if (sources.profileSource) {
    const listed = await sources.profileSource.listProfiles();
    if (listed.ok) {
      const files = listed.value.filter((name) => name !== DEFAULT_PROFILE);
      snapshot.profiles = {
        names: [DEFAULT_PROFILE, ...files],
        active: sources.activeProfile ?? null,
      };
    } else snapshot.errors.push("profiles could not be listed");
  }
  if (sources.toolController) snapshot.tools = sources.toolController.list();
  if (sources.reasoning) {
    snapshot.reasoning = {
      levels: REASONING_EFFORTS,
      active: sources.reasoning.getReasoningEffort() ?? "default",
    };
  }
  if (sources.sessionSource) {
    const listed = await sources.sessionSource.list();
    if (listed.ok) {
      snapshot.sessions = listed.value.map((e) => ({
        id: e.id,
        name: e.name,
        ...(e.updated === undefined ? {} : { updated: e.updated }),
      }));
    } else snapshot.errors.push("saved sessions could not be listed");
  }
  return snapshot;
}
