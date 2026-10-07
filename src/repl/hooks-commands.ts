import type { Result } from "../core/errors.ts";
import { formatHooks } from "../output/format.ts";
import type {
  HookSource,
  PostTurnHook,
  PreTurnHook,
  ProfileSource,
} from "./ports.ts";

/** The live hook lists (mutated in place), the store that persists them, and the profiles hooks bind to. */
export interface HooksState {
  pre: PreTurnHook[];
  post: PostTurnHook[];
  source?: HookSource;
  profiles?: ProfileSource;
}

/** One hook as shown to users: its command and the profiles it is bound to. */
export interface HookLine {
  command: string;
  profiles: string[];
}

/** Every hook with its bindings, plus the profiles that can be bound to. */
export interface HooksView {
  pre: HookLine[];
  post: HookLine[];
  profiles: string[];
}

const USAGE =
  'usage: /hooks | /hooks add pre|post "<command>" | /hooks remove pre|post <number> | /hooks bind|unbind pre|post <number> <profile>';

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

/** The hook commands bound to each profile; empty when profiles cannot carry bindings. */
export async function readBindings(
  profiles: ProfileSource | undefined,
): Promise<Record<string, string[]>> {
  const result = await profiles?.hookBindings?.();
  return result?.ok ? result.value : {};
}

/**
 * Whether a hook runs under `activeProfile`: a hook bound to no profile always
 * runs; a bound hook runs only while one of its profiles is active.
 */
export function hookApplies(
  command: string,
  activeProfile: string | undefined,
  bindings: Record<string, string[]>,
): boolean {
  const bound = Object.values(bindings).some((c) => c.includes(command));
  if (!bound) return true;
  return (
    activeProfile !== undefined && !!bindings[activeProfile]?.includes(command)
  );
}

/** Every hook with its bindings and the available profile names. */
export async function hooksView(state: HooksState): Promise<HooksView> {
  const bindings = await readBindings(state.profiles);
  const line = (command: string): HookLine => ({
    command,
    profiles: Object.keys(bindings).filter((p) =>
      bindings[p]?.includes(command),
    ),
  });
  const names = await state.profiles?.listProfiles();
  return {
    pre: state.pre.map((h) => line(h.command)),
    post: state.post.map((h) => line(h.command)),
    profiles: names?.ok ? names.value : [],
  };
}

/**
 * Handle `/hooks` and its edit forms:
 * `add <pre|post> "<command>"`, `remove <pre|post> <number>`, and
 * `bind|unbind <pre|post> <number> <profile>` (a bound hook runs only while one
 * of its profiles is active; a hook may bind to many profiles and a profile to
 * many hooks). Edits apply to the running session at once; hook lists are saved
 * through the `HookSource` (`.viserc.json`) and bindings through the profile
 * file's `hooks:` frontmatter. A failed save is rolled back.
 */
export async function handleHooksCommand(
  line: string,
  state: HooksState,
): Promise<Result<string>> {
  const args = line.slice("/hooks".length).trim();
  if (args === "") {
    const view = await hooksView(state);
    return { ok: true, value: formatHooks(view) };
  }
  const bind = /^(bind|unbind)\s+(pre|post)\s+(\d+)\s+(\S+)$/.exec(args);
  if (bind) {
    const [, verb, phase, n, profile] = bind;
    return bindHook(
      state,
      verb === "bind",
      phase === "pre",
      Number(n),
      profile ?? "",
    );
  }
  const match = /^(add|remove)\s+(pre|post)\s*([\s\S]*)$/.exec(args);
  if (!match) return fail(USAGE);
  const [, verb, phase, rest = ""] = match;
  const source = state.source;
  if (!source) return fail("hooks cannot be edited by the current client");
  const hooks = phase === "pre" ? state.pre : state.post;
  const label = phase === "pre" ? "pre-turn" : "post-turn";

  if (verb === "add") {
    const command = unquote(rest);
    if (command === "") return fail(USAGE);
    hooks.push(source.create(command));
    const saved = persist(state, source);
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
  const saved = persist(state, source);
  if (!saved.ok) {
    hooks.splice(index, 0, hook);
    return saved;
  }
  await dropBindingsFor(state, hook.command);
  return {
    ok: true,
    value: `removed ${label} hook ${index + 1}: ${hook.command}`,
  };
}

function persist(state: HooksState, source: HookSource): Result<void> {
  return source.save({
    pre: state.pre.map((h) => h.command),
    post: state.post.map((h) => h.command),
  });
}

async function bindHook(
  state: HooksState,
  bind: boolean,
  isPre: boolean,
  number: number,
  profile: string,
): Promise<Result<string>> {
  const profiles = state.profiles;
  if (!profiles?.setProfileHooks || !profiles.hookBindings) {
    return fail("profile hook bindings not supported by the current client");
  }
  const hook = (isPre ? state.pre : state.post)[number - 1];
  if (!hook)
    return fail(`no ${isPre ? "pre" : "post"}-turn hook numbered '${number}'.`);
  const names = await profiles.listProfiles();
  if (!names.ok) return names;
  if (!names.value.includes(profile)) {
    return fail(
      `unknown profile '${profile}'. Run '/profile' to see available profiles.`,
    );
  }
  const bindings = await readBindings(profiles);
  const current = bindings[profile] ?? [];
  const next = bind
    ? [...new Set([...current, hook.command])]
    : current.filter((c) => c !== hook.command);
  const saved = await profiles.setProfileHooks(profile, next);
  if (!saved.ok) return saved;
  state.source?.notify?.();
  return {
    ok: true,
    value: bind
      ? `hook ${number} now runs only with profile '${profile}' (and any other profile it is bound to)`
      : `hook ${number} unbound from profile '${profile}'`,
  };
}

/** A removed hook's command stops being bound anywhere (unless another hook shares it). */
async function dropBindingsFor(
  state: HooksState,
  command: string,
): Promise<void> {
  const profiles = state.profiles;
  if (!profiles?.setProfileHooks) return;
  const stillUsed = [...state.pre, ...state.post].some(
    (h) => h.command === command,
  );
  if (stillUsed) return;
  const bindings = await readBindings(profiles);
  for (const [profile, commands] of Object.entries(bindings)) {
    if (commands.includes(command)) {
      await profiles.setProfileHooks(
        profile,
        commands.filter((c) => c !== command),
      );
    }
  }
}
