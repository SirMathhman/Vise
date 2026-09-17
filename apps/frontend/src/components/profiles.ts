import { LLM_TOOL_NAMES } from "@vise/shared";

/** localStorage key for the persisted profile list. */
const STORAGE_PROFILES = "vise:llm:profiles";

/** The id of the always-present default profile; it cannot be deleted. */
export const DEFAULT_PROFILE_ID = "default";

/**
 * The default profile's system prompt: the app's original, single hardcoded
 * SYSTEM_PROMPT text, preserved verbatim as the seed value so a fresh install
 * (or a conversation that has never touched a profile) behaves exactly as it
 * did before profiles existed.
 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant that can inspect and modify files in a " +
  "workspace. To see what exists, call list_directory with the directory " +
  'path relative to the root (use "" for the root). To read a file, call ' +
  "read_file with the path and a 1-based line range (start_line inclusive, " +
  "end_line exclusive). To edit an existing file, call edit_file with the " +
  "path, a 1-based line range (start_line inclusive, end_line exclusive), and " +
  "the replacement content; always read_file first so you know the exact lines " +
  "to replace. To create new files or directories, call create_file or " +
  "create_directory. To run a PowerShell command (builds, git, typecheck, " +
  "file operations, etc.), call run_command with the command; it runs in the " +
  "workspace root and returns its output and exit status. To delegate a " +
  "self-contained sub-task to an independent helper (e.g. a focused search or " +
  "fix that doesn't need this conversation's context), call create_subagent " +
  "with a clear task description; it returns the helper's final answer. Base " +
  "your answer on the tools' results.";

/**
 * A named, reusable bundle of everything that shapes how the model behaves:
 * its system prompt, which tools it may call (an allowlist — anything not
 * listed is unavailable), and its three hook commands (startup/turn/end, the
 * same semantics as a conversation's used to have). A conversation picks one
 * profile as its sole source of truth for tools and hooks; create_subagent
 * can also name a profile to delegate under, instead of the built-in helper
 * defaults.
 */
export interface Profile {
  id: string;
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  /** Runs once before the first message/task under this profile. Empty = none. */
  hookCommand: string;
  /** Runs fresh before every turn/iteration. Empty = none. */
  turnCommand: string;
  /** Runs after every reply; blocks on stderr. Empty = none. */
  endCommand: string;
}

/** Build the seeded default profile: all tools allowed, no hooks. */
function makeDefaultProfile(): Profile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    allowedTools: [...LLM_TOOL_NAMES],
    hookCommand: "",
    turnCommand: "",
    endCommand: "",
  };
}

/** Generate a unique id for a new profile. */
function newId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the timestamp id.
  }
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** True when `value` is a structurally valid persisted profile. */
function isValidProfile(value: unknown): value is Profile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.systemPrompt === "string" &&
    Array.isArray(p.allowedTools) &&
    (p.allowedTools as unknown[]).every((v) => typeof v === "string") &&
    typeof p.hookCommand === "string" &&
    typeof p.turnCommand === "string" &&
    typeof p.endCommand === "string"
  );
}

/**
 * Restore the persisted profiles, seeding the default profile if it's
 * missing (first run, or a store that somehow lost it) so it's always
 * present. The default profile's own fields, if already persisted, are kept
 * as the user left them (e.g. they trimmed its allowed tools) rather than
 * reset to the seed every load.
 */
function loadProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(STORAGE_PROFILES);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const profiles = parsed.filter(isValidProfile);
        if (profiles.some((p) => p.id === DEFAULT_PROFILE_ID)) {
          return profiles;
        }
        if (profiles.length > 0) return [makeDefaultProfile(), ...profiles];
      }
    }
  } catch {
    return [makeDefaultProfile()];
  }
  return [makeDefaultProfile()];
}

/** Persist the profile list. */
function saveProfiles(profiles: Profile[]): void {
  try {
    localStorage.setItem(STORAGE_PROFILES, JSON.stringify(profiles));
  } catch {
    // Storage may be unavailable (private mode, quota); persistence is a
    // best-effort enhancement, so failures are ignored.
  }
}

/**
 * A stateful profile store, mirroring conversations.ts's ConversationStore
 * shape: DOM-free, persists to localStorage, and always keeps the default
 * profile present so callers never need to null-check it.
 */
export interface ProfileStore {
  /** All profiles, in list order (default first). */
  getProfiles(): Profile[];
  /** A profile by id, if it exists. */
  getProfile(id: string): Profile | undefined;
  /** The always-present default profile. */
  getDefault(): Profile;
  /** Create a new profile (empty prompt, every tool allowed, no hooks) and return it. */
  createProfile(name: string): Profile;
  /** Merge `patch` into the profile with this id; a no-op if it doesn't exist. */
  updateProfile(id: string, patch: Partial<Omit<Profile, "id">>): void;
  /**
   * Delete the profile with this id. Refuses (returns false) for the default
   * profile or an unknown id; a conversation store must reassign any
   * conversation still pointing at the deleted profile — this store only
   * owns profiles, not conversations.
   */
  deleteProfile(id: string): boolean;
  /** Persist the store. */
  persist(): void;
}

/** Build a profile store from persisted state, seeding the default profile. */
export function createProfileStore(): ProfileStore {
  let profiles: Profile[] = loadProfiles();

  const getProfile = (id: string) => profiles.find((p) => p.id === id);

  return {
    getProfiles: () => profiles,
    getProfile,
    getDefault: () => getProfile(DEFAULT_PROFILE_ID) ?? makeDefaultProfile(),
    createProfile(name) {
      const profile: Profile = {
        id: newId(),
        name,
        systemPrompt: "",
        allowedTools: [...LLM_TOOL_NAMES],
        hookCommand: "",
        turnCommand: "",
        endCommand: "",
      };
      profiles = [...profiles, profile];
      return profile;
    },
    updateProfile(id, patch) {
      const profile = getProfile(id);
      if (!profile) return;
      Object.assign(profile, patch);
    },
    deleteProfile(id) {
      if (id === DEFAULT_PROFILE_ID) return false;
      if (!getProfile(id)) return false;
      profiles = profiles.filter((p) => p.id !== id);
      return true;
    },
    persist() {
      saveProfiles(profiles);
    },
  };
}
