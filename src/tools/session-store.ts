import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore } from "../core/sessions.ts";
import { err, ok } from "../core/result.ts";

// Saved sessions live in .vise/sessions/<name>.json under the working directory.
const SESSIONS_FOLDER = join(".vise", "sessions");
const EXTENSION = ".json";

// The store for a working directory. The names are checked by the caller, before they get here.
export function sessionStore(root: string): SessionStore {
  const folder = join(root, SESSIONS_FOLDER);
  return {
    async save(name, text) {
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, name + EXTENSION), text, "utf8");
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
    async load(name) {
      try {
        return ok(await readFile(join(folder, name + EXTENSION), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return err(new Error(`no saved session named ${name}`));
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
    async list() {
      try {
        const files = await readdir(folder);
        return ok(
          files
            .filter((file) => file.endsWith(EXTENSION))
            .map((file) => file.slice(0, -EXTENSION.length))
            .sort(),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return ok([] as string[]);
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
