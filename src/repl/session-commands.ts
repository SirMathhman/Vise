import type { Result } from "../core/errors.ts";
import { formatProfileList, formatSessionList } from "../output/format.ts";
import type { ProfileCommands, SessionCommands } from "./session.ts";

/**
 * The reserved name of the built-in profile. `default` is not a file under
 * `profiles/`; it is a constant resolved directly by the session, so there is
 * always a baseline persona even when `profiles/` is empty. A file named
 * `default.md` would be shadowed by this constant (the constant always wins),
 * the same way `auto` is reserved for sessions.
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

/** A successful no-op compaction result: nothing needed to be compacted. */
function okNoop(): Result<string> {
  return { ok: true, value: "nothing to compact" };
}

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
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "profiles not supported by the current client",
      },
    };
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

  const sub = arg.split(" ")[0];
  if (sub === "init") {
    const name = arg.slice("init".length).trim();
    if (name === "") {
      return {
        ok: false,
        error: { kind: "malformed", body: "usage: /profile init <name>" },
      };
    }
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
  return {
    ok: true,
    value: body === "" ? "profile cleared" : `profile set to ${arg}`,
  };
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
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "session persistence not supported by the current client",
      },
    };
  }

  const arg = line.slice("/resume".length).trim();
  if (arg === "") {
    const names = await sessionSource.list();
    if (!names.ok) return names;
    return { ok: true, value: formatSessionList(names.value) };
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
  return {
    ok: true,
    value: `resumed session '${arg}' (${saved.messages.length - 1} messages)`,
  };
}

/**
 * Handle `/save` and `/save <name>`. When name is omitted: lists all saved
 * sessions. When a name is provided: persists the current conversation
 * under that name (the fixed auto-save snapshot is separate and written
 * after every successful turn). Fails with a `malformed` error when the
 * name is invalid.
 */
export async function handleSaveCommand(
  session: SessionCommands,
  line: string,
): Promise<Result<string>> {
  const sessionSource = session.sessionSource();
  if (!sessionSource) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "session persistence not supported by the current client",
      },
    };
  }

  const arg = line.slice("/save".length).trim();
  if (arg === "") {
    const names = await sessionSource.list();
    if (!names.ok) return names;
    return { ok: true, value: formatSessionList(names.value) };
  }

  const saved = await sessionSource.saveNamed(
    arg,
    session.messages(),
    session.activeProfile(),
  );
  if (!saved.ok) return saved;
  return { ok: true, value: `saved session '${arg}'` };
}
