import type { Result } from "../../core/errors.ts";
import { newNameProblem, unsupported } from "./registry.ts";
import { formatProfileList, formatSessionList } from "../../output/format.ts";
import { saveProfileWhitelist } from "../profile-tools.ts";
import type {
  ProfileCommands,
  ProfileSource,
  SessionCommands,
} from "../session.ts";

/**
 * The reserved name of the built-in profile. `default` is not a file under
 * `profiles/`; it is a constant resolved directly by the session, so there is
 * always a baseline persona even when `profiles/` is empty. A file named
 * `default.md` would be shadowed by this constant (the constant always wins).
 */
const DEFAULT_PROFILE_NAME = "default";

/**
 * The body of the built-in `default` profile, a general assistant baseline
 * distinct from the subagent's `DEFAULT_PROFILE`. It is appended as a user
 * message when the user runs `/profile default`, shaping the conversation
 * without ever touching the system message.
 */
const DEFAULT_PROFILE_TEXT =
  "You are a helpful assistant. Respond clearly and concisely, and use your tools when a task requires them.";

/**
 * Handle `/profile` and `/profile <name>`.
 * When name is omitted: lists available profiles from the source.
 * When name is provided: loads the profile text and appends it to the
 * conversation as a user message. The system message is never modified
 * (invariant: profile instructions are appended, not injected into the
 * system prompt, to preserve prefix caching).
 * An empty profile file appends a clearing instruction instead.
 */
export async function handleProfileCommand(
  session: ProfileCommands,
  line: string,
): Promise<Result<string>> {
  const profileSource = session.profileSource();
  if (!profileSource) {
    return unsupported("profiles");
  }

  const arg = line.slice("/profile".length).trim();
  if (arg === "") {
    const profiles = await profileSource.listProfiles();
    if (!profiles.ok) return profiles;
    // The built-in default profile is always available even when no files
    // exist under profiles/; surface it first so it is discoverable.
    return {
      ok: true,
      value: formatProfileList(
        [DEFAULT_PROFILE_NAME, ...profiles.value],
        session.activeProfile(),
      ),
    };
  }

  const words = arg.split(/\s+/);
  if (words[1] === "tools") {
    return handleProfileTools(
      session,
      profileSource,
      words[0] ?? "",
      words.slice(2),
    );
  }
  const sub = words[0];
  if (sub === "init") {
    const name = arg.slice("init".length).trim();
    if (name === "") {
      return {
        ok: false,
        error: { kind: "malformed", body: "usage: /profile init <name>" },
      };
    }
    const problem = newNameProblem(name);
    if (problem) return { ok: false, error: { kind: "malformed", body: problem } };
    const result = await profileSource.initProfile(name);
    if (!result.ok) return result;
    return { ok: true, value: `initialized profile '${name}'` };
  }

  // The built-in default profile is resolved directly, not via the
  // ProfileSource, since it has no file. It always has a non-empty body,
  // so this is the "set" path, never the clearing path.
  if (arg === DEFAULT_PROFILE_NAME) {
    session.setActiveProfile(DEFAULT_PROFILE_NAME);
    session.pushMessage({ role: "user", content: DEFAULT_PROFILE_TEXT });
    await applyWhitelist(session, profileSource, undefined);
    return { ok: true, value: `profile set to ${arg}` };
  }

  const loaded = await profileSource.loadProfile(arg);
  if (!loaded.ok) return loaded;
  const body = loaded.value.trim();
  session.setActiveProfile(body === "" ? undefined : arg);
  if (body !== "") {
    session.pushMessage({ role: "user", content: body });
  } else {
    session.pushMessage({
      role: "user",
      content:
        "Profile cleared. Please disregard any previous profile instructions.",
    });
  }
  await applyWhitelist(session, profileSource, body === "" ? undefined : arg);
  return {
    ok: true,
    value: body === "" ? "profile cleared" : `profile set to ${arg}`,
  };
}

/** Apply the named profile's tool whitelist (undefined name: lift it). */
export async function applyWhitelist(
  session: Pick<ProfileCommands, "applyProfileTools">,
  source: ProfileSource | undefined,
  name: string | undefined,
): Promise<void> {
  const tools =
    name !== undefined && name !== DEFAULT_PROFILE_NAME && source?.profileTools
      ? await source.profileTools(name)
      : undefined;
  session.applyProfileTools(tools?.ok ? tools.value : undefined);
}

/**
 * Handle `/profile <name> tools`, `... tools all`, and `... tools a,b`: show,
 * clear, or set a profile's tool whitelist. Only the profile file changes;
 * the whitelist applies the next time the profile is switched to, so editing
 * the active profile leaves the conversation untouched.
 */
async function handleProfileTools(
  session: ProfileCommands,
  source: ProfileSource,
  name: string,
  args: string[],
): Promise<Result<string>> {
  const fail = (body: string): Result<string> => ({
    ok: false,
    error: { kind: "malformed", body },
  });
  if (!source.profileTools || !source.setProfileTools) {
    return fail("tool whitelists not supported by the current client");
  }
  const current = await source.profileTools(name);
  if (!current.ok) return current;
  const show = (tools: string[] | undefined): Result<string> => ({
    ok: true,
    value: `profile '${name}' tools: ${tools === undefined ? "all" : tools.join(", ") || "(none)"}`,
  });
  const list = args
    .join(",")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (list.length === 0) return show(current.value);
  const next = list.length === 1 && list[0] === "all" ? undefined : list;
  const saved = await saveProfileWhitelist(
    source,
    session.toolNames(),
    name,
    next,
  );
  return saved.ok ? show(next) : saved;
}

/**
 * Handle `/resume` and `/resume <name>`. When name is omitted: lists all
 * saved sessions. When a name is provided: loads the saved conversation
 * and replaces the current messages array, restoring the active profile.
 * The system message is always the one from the current Session (invariant
 * #6); the saved messages are a full snapshot including the original system
 * message, so on restore the saved system message replaces the live one
 * and the rest of the conversation is spliced in.
 */
export async function handleResumeCommand(
  session: SessionCommands,
  line: string,
): Promise<Result<string>> {
  const sessionSource = session.sessionSource();
  if (!sessionSource) {
    return unsupported("session persistence");
  }

  const arg = line.slice("/resume".length).trim();
  if (arg === "") {
    const entries = await sessionSource.list();
    if (!entries.ok) return entries;
    return { ok: true, value: formatSessionList(entries.value) };
  }

  const loaded = await sessionSource.load(arg);
  if (!loaded.ok) return loaded;
  const saved = loaded.value;
  // Replace the live conversation with the saved body, but keep the live
  // system message at index 0 (invariant #6: the system message is set once
  // in the constructor and never modified). The saved snapshot carries its
  // own redundant system message; we drop it and splice the saved body
  // (index 1 onwards) back in. This makes resume symmetric with doCompact,
  // which also restores this.systemMessage at index 0.
  const savedBody = saved.messages.slice(1);
  session.resetMessages(savedBody);
  session.setActiveProfile(saved.activeProfile);
  // The profile's tool whitelist is part of being in it, as after `/new`.
  await session.applyProfileTools?.(saved.activeProfile);
  session.todos?.set(saved.todos ?? []);
  session.goalLog?.set(saved.goalTrace ?? []);
  // A resumed conversation keeps writing to its own session.
  session.setSession(saved.id, saved.name);
  return {
    ok: true,
    value: `resumed session '${saved.name}' (${saved.id}, ${saved.messages.length - 1} messages)`,
  };
}

/**
 * Handle `/save` and `/save <name>`. When name is omitted: lists all saved
 * sessions. When a name is given: names the current conversation's session
 * (renaming it if it already has one, creating it otherwise) and saves it.
 * Auto-save keeps updating that same session. Fails with a `malformed` error
 * when the name is blank.
 */
export async function handleSaveCommand(
  session: SessionCommands,
  line: string,
): Promise<Result<string>> {
  const sessionSource = session.sessionSource();
  if (!sessionSource) {
    return unsupported("session persistence");
  }

  const arg = line.slice("/save".length).trim();
  if (arg === "") {
    const entries = await sessionSource.list();
    if (!entries.ok) return entries;
    return { ok: true, value: formatSessionList(entries.value) };
  }

  const saved = await sessionSource.save(
    session.currentSession().id,
    arg,
    session.messages(),
    session.activeProfile(),
    session.todos?.get(),
    session.goalLog?.entries(),
  );
  if (!saved.ok) return saved;
  session.setSession(saved.value, arg);
  return { ok: true, value: `saved session '${arg}' (${saved.value})` };
}

/**
 * Handle `/delete <id>`. Deletes a saved session (including auto-saved ones).
 * Deleting the conversation's own session detaches it, so the next auto-save
 * starts a new session instead of resurrecting the deleted one. Fails with a
 * `malformed` error when the session does not exist.
 */
export async function handleDeleteCommand(
  session: SessionCommands,
  line: string,
): Promise<Result<string>> {
  const sessionSource = session.sessionSource();
  if (!sessionSource) {
    return unsupported("session persistence");
  }

  const arg = line.slice("/delete".length).trim();
  if (arg === "") {
    return {
      ok: false,
      error: { kind: "malformed", body: "usage: /delete <id>" },
    };
  }

  const deleted = await sessionSource.delete(arg);
  if (!deleted.ok) return deleted;
  if (session.currentSession().id === deleted.value) {
    session.setSession(undefined, undefined);
  }
  return { ok: true, value: `deleted session ${deleted.value}` };
}
