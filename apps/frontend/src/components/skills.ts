/**
 * A skill is a named, reusable block of domain instructions: a unique name
 * (what the model passes to use_skill), a short summary (shown in the system
 * prompt so the model can decide when to load it), and the full content
 * (loaded into context on demand via use_skill). Skills are stored in
 * localStorage (not files), mirroring profiles.ts's ProfileStore shape:
 * DOM-free, persisted, and unit-testable in Node.
 */

/** localStorage key for the persisted skill list. */
const STORAGE_SKILLS = "vise:llm:skills";

/**
 * A single skill. `name` is the model-facing id: it is unique, fixed after
 * creation, and is what the model passes to the use_skill tool. `summary`
 * is the one-line description shown in the system prompt's available-skills
 * list. `content` is the full instruction text loaded into context when the
 * model calls use_skill with this skill's name.
 */
export interface Skill {
  /** Unique name; fixed after creation; the argument to use_skill. */
  name: string;
  /** One-line summary shown in the system prompt's skill list. */
  summary: string;
  /** Full instruction text loaded into context via use_skill. */
  content: string;
}

/** True when `value` is a structurally valid persisted skill. */
function isValidSkill(value: unknown): value is Skill {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.name === "string" &&
    typeof s.summary === "string" &&
    typeof s.content === "string"
  );
}

/**
 * Restore the persisted skill list. Returns an empty array when nothing is
 * stored (first run) or the stored value is malformed.
 */
function loadSkills(): Skill[] {
  try {
    const raw = localStorage.getItem(STORAGE_SKILLS);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(isValidSkill);
      }
    }
  } catch {
    return [];
  }
  return [];
}

/** Persist the skill list. */
function saveSkills(skills: Skill[]): void {
  try {
    localStorage.setItem(STORAGE_SKILLS, JSON.stringify(skills));
  } catch {
    // Storage may be unavailable (private mode, quota); persistence is a
    // best-effort enhancement, so failures are ignored.
  }
}

/**
 * A stateful skill store, mirroring profiles.ts's ProfileStore shape:
 * DOM-free, persists to localStorage. Skills are keyed by their unique
 * `name` (not an internal id) because the name is what the model uses to
 * call use_skill — it is the model-facing identifier.
 */
export interface SkillStore {
  /** All skills, in list order. */
  getSkills(): Skill[];
  /** A skill by name, if it exists. */
  getSkill(name: string): Skill | undefined;
  /**
   * Create a new skill with the given unique name and empty summary/content.
   * Returns undefined when a skill with that name already exists (the name
   * is the uniqueness key); the caller (the UI) is responsible for enforcing
   * a non-empty name before calling.
   */
  createSkill(name: string): Skill | undefined;
  /**
   * Merge `patch` into the skill with the given name; a no-op if no skill
   * has that name. The name itself is not patchable (it is fixed after
   * creation).
   */
  updateSkill(name: string, patch: Partial<Omit<Skill, "name">>): void;
  /**
   * Delete the skill with the given name. Returns false when no skill has
   * that name.
   */
  deleteSkill(name: string): boolean;
  /** Persist the store. */
  persist(): void;
}

/** Build a skill store from persisted state. */
export function createSkillStore(): SkillStore {
  let skills: Skill[] = loadSkills();

  const getSkill = (name: string) => skills.find((s) => s.name === name);

  return {
    getSkills: () => skills,
    getSkill,
    createSkill(name) {
      if (getSkill(name)) return undefined;
      const skill: Skill = { name, summary: "", content: "" };
      skills = [...skills, skill];
      return skill;
    },
    updateSkill(name, patch) {
      const skill = getSkill(name);
      if (!skill) return;
      Object.assign(skill, patch);
    },
    deleteSkill(name) {
      if (!getSkill(name)) return false;
      skills = skills.filter((s) => s.name !== name);
      return true;
    },
    persist() {
      saveSkills(skills);
    },
  };
}
