import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NOTES_FOLDER,
  PROFILE_CATEGORY,
  checkName,
  checkProfileDetail,
  notePath,
  parseHeader,
  profileDetailOf,
  profileFile,
  type ProfileDetail,
  type ProfileStore,
  type ProfileSummary,
} from "../../core/notes.ts";
import { err, ok } from "../../core/messages.ts";
import { toolNames } from "../../core/tools.ts";
import { resolveInside } from "../files/contain.ts";
import { readNote } from "./read-note.ts";

// Profiles are the notes in notes/profile. The store lists and reads them through the containment check,
// and writes only a profile that already exists, so the page cannot create a new one.
export function profileStore(root: string): ProfileStore {
  return {
    async list() {
      let files: string[];
      try {
        files = await readdir(join(root, NOTES_FOLDER, PROFILE_CATEGORY));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
        return err(error instanceof Error ? error : new Error(String(error)));
      }
      const profiles: ProfileSummary[] = [];
      for (const file of files.filter((entry) => entry.endsWith(".md")).sort()) {
        const name = file.slice(0, -".md".length);
        if (!checkName(name, "profile name").ok) continue;
        const text = await readNote(root, notePath(PROFILE_CATEGORY, name));
        if (!text.ok) continue;
        const header = parseHeader(text.value);
        if (header.ok) profiles.push({ name, summary: header.value.summary });
      }
      return ok(profiles);
    },
    async read(name) {
      const checked = checkName(name, "profile name");
      if (!checked.ok) return err(checked.error);
      const text = await readNote(root, notePath(PROFILE_CATEGORY, name));
      if (!text.ok) return err(text.error);
      return profileDetailOf(text.value);
    },
    async write(detail: ProfileDetail) {
      const valid = checkProfileDetail(detail);
      if (!valid.ok) return valid;
      const unknown = (detail.tools ?? []).find((tool) => !toolNames.includes(tool));
      if (unknown !== undefined) return err(new Error(`${unknown} is not a tool`));
      const place = await resolveInside(root, notePath(PROFILE_CATEGORY, detail.name));
      if (!place.ok) return err(new Error(`no profile named ${detail.name}`));
      try {
        await writeFile(place.value.realTarget, profileFile(detail), "utf8");
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
