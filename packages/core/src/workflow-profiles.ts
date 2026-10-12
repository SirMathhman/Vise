import type { Result } from "./errors.ts";
import type { Workflow } from "./workflow.ts";

/**
 * What a workflow needs from the session to switch profile: do the switch (as
 * `/profile <name>` does, so the profile's text and tool list take effect),
 * read a profile's tool whitelist without switching, and tell which tools are
 * enabled now and which the user has enabled apart from any profile.
 */
export interface WorkflowProfiles {
  apply(name: string): Promise<Result<string>>;
  /** A profile's tool whitelist; undefined when it has none. */
  tools(name: string): Promise<Result<string[] | undefined>>;
  /** The tools enabled right now. */
  enabled(): string[];
  /** The tools enabled by the user's own settings (what a profile with no whitelist returns to). */
  baseline(): string[];
}

const refuse = (body: string): Result<void> => ({
  ok: false,
  error: { kind: "malformed", body },
});

/**
 * Walk the steps in order, following the profile steps, and refuse a workflow
 * whose tool step calls a tool that is not available at that point. Only tool
 * steps are checked: what an instruction step needs is up to the model.
 */
export async function checkToolAvailability(
  workflow: Workflow,
  profiles: WorkflowProfiles,
): Promise<Result<void>> {
  let available = new Set(profiles.enabled());
  let profile: string | undefined;
  for (const [index, step] of workflow.steps.entries()) {
    if (step.type === "profile") {
      const tools = await profiles.tools(step.name);
      if (!tools.ok) return tools;
      available = new Set(tools.value ?? profiles.baseline());
      profile = step.name;
    } else if (step.type === "tool" && !available.has(step.name)) {
      const under = profile ? `profile '${profile}'` : "the current tool settings";
      return refuse(
        `workflow step ${index + 1} calls '${step.name}', which ${under} does not allow`,
      );
    }
  }
  return { ok: true, value: undefined };
}

/** Run a profile step: switch the session to the named profile. */
export async function runProfileStep(
  profiles: WorkflowProfiles | undefined,
  name: string,
): Promise<Result<void>> {
  if (!profiles) return refuse("profile steps are not supported here");
  const applied = await profiles.apply(name);
  return applied.ok ? { ok: true, value: undefined } : applied;
}
