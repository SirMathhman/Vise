import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Profiles live outside the repository, in the user's home directory, so they
// persist across backend restarts without appearing in the browsed file tree.
// A profile is a named block of instructions injected into the LLM context as
// a system message for the conversations that select it — the "custom agent"
// persona the user can switch between from the chat header. Each profile is
// `{ name, instructions }`; names are unique case-insensitively.
const profilesDir = join(homedir(), ".vise-profiles");
const profilesPath = join(profilesDir, "profiles.json");

/**
 * Loads the stored profiles. Returns an empty array when none exist yet. A
 * missing or unparseable file is treated as empty (rather than fatal) so a
 * single bad write can't wedge the agent; the next save rewrites the file.
 * @returns {Promise<Array<{name: string, instructions: string}>>}
 */
export async function loadProfiles() {
  try {
    const raw = await readFile(profilesPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return err.code === "ENOENT" ? [] : [];
  }
}

/**
 * Persists the profiles store, creating the profiles directory on first write.
 * @param {Array<{name: string, instructions: string}>} profiles
 * @returns {Promise<void>}
 */
export async function saveProfiles(profiles) {
  await mkdir(dirname(profilesPath), { recursive: true });
  await writeFile(profilesPath, JSON.stringify(profiles, null, 2), "utf8");
}

/**
 * Returns every stored profile, sorted by name (case-insensitive) so the UI
 * list is stable.
 * @returns {Promise<Array<{name: string, instructions: string}>>}
 */
export async function listProfiles() {
  const profiles = await loadProfiles();
  return [...profiles].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * Adds or updates a profile by name (case-insensitive). An existing name is
 * updated in place (preserving its original casing); a new name is appended.
 * Names must be non-empty. Returns the upserted profile.
 * @param {string} name
 * @param {string} instructions
 * @returns {Promise<{name: string, instructions: string}>}
 */
export async function upsertProfile(name, instructions) {
  const profiles = await loadProfiles();
  const key = name.toLowerCase();
  const existing = profiles.find((p) => p.name.toLowerCase() === key);
  if (existing) {
    existing.instructions = instructions;
    await saveProfiles(profiles);
    return existing;
  }
  const profile = { name, instructions };
  profiles.push(profile);
  await saveProfiles(profiles);
  return profile;
}

/**
 * Deletes a profile by name (case-insensitive). Returns `{ ok: true }` on
 * success, or `{ ok: false, reason }` when no such profile exists.
 * @param {string} name
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function deleteProfile(name) {
  const profiles = await loadProfiles();
  const key = name.toLowerCase();
  const index = profiles.findIndex((p) => p.name.toLowerCase() === key);
  if (index === -1) {
    return { ok: false, reason: `No profile named "${name}" exists.` };
  }
  profiles.splice(index, 1);
  await saveProfiles(profiles);
  return { ok: true };
}
