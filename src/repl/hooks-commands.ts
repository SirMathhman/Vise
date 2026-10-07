import type { Result } from "../core/errors.ts";
import { formatHooks } from "../output/format.ts";
import type { HookSource, PostTurnHook, PreTurnHook } from "./ports.ts";

/** The live hook lists (mutated in place) and the store that persists them. */
export interface HooksState {
  pre: PreTurnHook[];
  post: PostTurnHook[];
  source?: HookSource;
}

const USAGE =
  'usage: /hooks | /hooks add pre|post "<command>" | /hooks remove pre|post <number>';

function fail(body: string): Result<string> {
  return { ok: false, error: { kind: "malformed", body } };
}

/** `"cmd"` -> `cmd` (with `\"` unescaped); an unquoted command is taken as typed. */
function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replaceAll('\\"', '"');
  }
  return t;
}

/**
 * Handle `/hooks`, `/hooks add <pre|post> "<command>"` and
 * `/hooks remove <pre|post> <number>`. Edits apply to the running session at
 * once and are saved through the `HookSource` (`.viserc.json`), so they
 * survive a restart; a failed save is rolled back.
 */
export function handleHooksCommand(
  line: string,
  state: HooksState,
): Result<string> {
  const args = line.slice("/hooks".length).trim();
  if (args === "") {
    return {
      ok: true,
      value: formatHooks({
        pre: state.pre.map((h) => h.command),
        post: state.post.map((h) => h.command),
      }),
    };
  }
  const match = /^(add|remove)\s+(pre|post)\s*([\s\S]*)$/.exec(args);
  if (!match) return fail(USAGE);
  const [, verb, phase, rest = ""] = match;
  if (!state.source)
    return fail("hooks cannot be edited by the current client");
  const hooks = phase === "pre" ? state.pre : state.post;
  const label = phase === "pre" ? "pre-turn" : "post-turn";

  if (verb === "add") {
    const command = unquote(rest);
    if (command === "") return fail(USAGE);
    hooks.push(state.source.create(command));
    const saved = persist(state);
    if (!saved.ok) {
      hooks.pop();
      return saved;
    }
    return { ok: true, value: `added ${label} hook: ${command}` };
  }

  const index = Number(rest.trim()) - 1;
  const hook = Number.isInteger(index) ? hooks[index] : undefined;
  if (!hook) {
    return fail(
      `no ${label} hook numbered '${rest.trim()}'. Run '/hooks' to see them.`,
    );
  }
  hooks.splice(index, 1);
  const saved = persist(state);
  if (!saved.ok) {
    hooks.splice(index, 0, hook);
    return saved;
  }
  return {
    ok: true,
    value: `removed ${label} hook ${index + 1}: ${hook.command}`,
  };
}

function persist(state: HooksState): Result<void> {
  return (state.source as HookSource).save({
    pre: state.pre.map((h) => h.command),
    post: state.post.map((h) => h.command),
  });
}
