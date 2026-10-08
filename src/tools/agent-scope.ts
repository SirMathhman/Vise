import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which tools the agent running right now may use, when that is not simply the
 * session's own settings. A subagent started with a profile that lists its
 * `tools:` may use exactly those, whatever the main agent is restricted to (a
 * planner without file tools still has an explorer that reads them). It follows
 * the subagent's work across awaits; outside any subagent it is undefined and
 * the session's enabled tools apply.
 */
const scope = new AsyncLocalStorage<ReadonlySet<string> | undefined>();

/** Run `work` as an agent limited to `allowed` (undefined: the session's own settings apply). */
export function withToolScope<T>(
  allowed: ReadonlySet<string> | undefined,
  work: () => T,
): T {
  return scope.run(allowed, work);
}

/** The tools the running agent is limited to, or undefined when only the session's settings apply. */
export function currentToolScope(): ReadonlySet<string> | undefined {
  return scope.getStore();
}
