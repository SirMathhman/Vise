import type { Result } from "../core/errors.ts";
import { formatHooks } from "../output/format.ts";
import type {
  HookSource,
  PostTurnHook,
  PreTurnHook,
  ProfileSource,
} from "./ports.ts";

/** The live global hook lists (mutated in place), the store that persists them, and the profiles that can own hooks. */
export interface HooksState {
  pre: PreTurnHook[];
  post: PostTurnHook[];
  source?: HookSource;
  profiles?: ProfileSource;
}

export type HookPhase = "pre" | "post";

/** A set of hook commands, by phase. */
export interface HookCommands {
  pre: string[];
  post: string[];
}

/** The global hooks, plus the hooks each profile owns and the profile names. */
export interface HooksView extends HookCommands {
  profiles: string[];
  profileHooks: Record<string, HookCommands>;
}

const USAGE =
  'usage: /hooks | /hooks add|remove pre|post "<command>"|<number> | /hooks profile <name> [add|remove pre|post "<command>"|<number>]';

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
 * A profile's own hooks live in its frontmatter `hooks:` line as
 * `pre:<command>` / `post:<command>` entries; this splits them by phase.
 */
export function splitProfileHooks(keys: string[]): HookCommands {
  const out: HookCommands = { pre: [], post: [] };
  for (const key of keys) {
    if (key.startsWith("pre:")) out.pre.push(key.slice(4));
    else if (key.startsWith("post:")) out.post.push(key.slice(5));
  }
  return out;
}

function joinProfileHooks(hooks: HookCommands): string[] {
  return [
    ...hooks.pre.map((c) => `pre:${c}`),
    ...hooks.post.map((c) => `post:${c}`),
  ];
}

/** The hooks each profile owns (profiles with none are omitted); empty when profiles cannot carry hooks. */
export async function readProfileHooks(
  profiles: ProfileSource | undefined,
): Promise<Record<string, HookCommands>> {
  const result = await profiles?.hookBindings?.();
  if (!result?.ok) return {};
  return Object.fromEntries(
    Object.entries(result.value).map(([name, keys]) => [
      name,
      splitProfileHooks(keys),
    ]),
  );
}

/** Every global hook, the hooks each profile owns, and the profile names. */
export async function hooksView(state: HooksState): Promise<HooksView> {
  const names = await state.profiles?.listProfiles();
  return {
    pre: state.pre.map((h) => h.command),
    post: state.post.map((h) => h.command),
    profiles: names?.ok ? names.value : [],
    profileHooks: await readProfileHooks(state.profiles),
  };
}

/**
 * Handle `/hooks` and its edit forms. Global hooks (`.viserc.json`) run with
 * every profile: `add <pre|post> "<command>"`, `remove <pre|post> <number>`.
 * A profile can also own hooks that run only while it is active, in addition to
 * the global ones: `profile <name>` lists them, `profile <name> add|remove ...`
 * edits them (stored in the profile file's `hooks:` frontmatter). Edits apply to
 * the running session at once; a failed save is rolled back.
 */
export async function handleHooksCommand(
  line: string,
  state: HooksState,
): Promise<Result<string>> {
  const args = line.slice("/hooks".length).trim();
  if (args === "") {
    return { ok: true, value: formatHooks(await hooksView(state)) };
  }
  const profile = /^profile\s+(\S+)\s*([\s\S]*)$/.exec(args);
  if (profile) {
    return profileCommand(state, profile[1] ?? "", profile[2] ?? "");
  }
  const match = /^(add|remove)\s+(pre|post)\s*([\s\S]*)$/.exec(args);
  if (!match) return fail(USAGE);
  return globalEdit(
    state,
    match[1] === "add",
    match[2] === "pre" ? "pre" : "post",
    match[3] ?? "",
  );
}

const labelOf = (phase: HookPhase): string =>
  phase === "pre" ? "pre-turn" : "post-turn";

async function globalEdit(
  state: HooksState,
  add: boolean,
  phase: HookPhase,
  rest: string,
): Promise<Result<string>> {
  const source = state.source;
  if (!source) return fail("hooks cannot be edited by the current client");
  const hooks = phase === "pre" ? state.pre : state.post;
  const label = labelOf(phase);
  const persist = (): Result<void> =>
    source.save({
      pre: state.pre.map((h) => h.command),
      post: state.post.map((h) => h.command),
    });

  if (add) {
    const command = unquote(rest);
    if (command === "") return fail(USAGE);
    if (hooks.some((h) => h.command === command)) {
      return fail(`a ${label} hook with that command already exists`);
    }
    hooks.push(source.create(command));
    const saved = persist();
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
  const saved = persist();
  if (!saved.ok) {
    hooks.splice(index, 0, hook);
    return saved;
  }
  return {
    ok: true,
    value: `removed ${label} hook ${index + 1}: ${hook.command}`,
  };
}

/** `/hooks profile <name> [add|remove pre|post ...]`: the hooks a profile owns. */
async function profileCommand(
  state: HooksState,
  name: string,
  rest: string,
): Promise<Result<string>> {
  const profiles = state.profiles;
  if (!profiles?.setProfileHooks || !profiles.hookBindings) {
    return fail("profile hooks not supported by the current client");
  }
  const names = await profiles.listProfiles();
  if (!names.ok) return names;
  if (!names.value.includes(name)) {
    return fail(
      `unknown profile '${name}'. Run '/profile' to see available profiles.`,
    );
  }
  const owned = (await readProfileHooks(profiles))[name] ?? {
    pre: [],
    post: [],
  };
  if (rest.trim() === "") {
    return {
      ok: true,
      value: formatHooks(
        owned,
        `profile '${name}': runs only while it is active`,
      ),
    };
  }
  const match = /^(add|remove)\s+(pre|post)\s*([\s\S]*)$/.exec(rest.trim());
  if (!match) return fail(USAGE);
  const phase: HookPhase = match[2] === "pre" ? "pre" : "post";
  const label = labelOf(phase);
  const list = owned[phase];
  const arg = match[3] ?? "";
  let message: string;
  if (match[1] === "add") {
    const command = unquote(arg);
    if (command === "") return fail(USAGE);
    if (list.includes(command)) {
      return fail(`profile '${name}' already has that ${label} hook`);
    }
    list.push(command);
    message = `added ${label} hook to profile '${name}': ${command}`;
  } else {
    const index = Number(arg.trim()) - 1;
    const command = Number.isInteger(index) ? list[index] : undefined;
    if (command === undefined) {
      return fail(
        `profile '${name}' has no ${label} hook numbered '${arg.trim()}'.`,
      );
    }
    list.splice(index, 1);
    message = `removed ${label} hook ${index + 1} from profile '${name}': ${command}`;
  }
  const saved = await profiles.setProfileHooks(name, joinProfileHooks(owned));
  if (!saved.ok) return saved;
  state.source?.notify?.();
  return { ok: true, value: message };
}
