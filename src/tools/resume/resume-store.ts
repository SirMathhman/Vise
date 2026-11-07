import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  decodeSession,
  encodeSession,
  type ResumeStore,
} from "../../core/sessions.ts";
import { err, ok } from "../../core/result.ts";

// The resume store for one working directory. The file lives in `folder`, outside the project, and its
// name comes from a hash of the directory's path: a conversation resumes only in the directory it came
// from, and a repository cannot ship one.
export function resumeStore(folder: string, root: string): ResumeStore {
  const name = createHash("sha256").update(resolve(root)).digest("hex");
  const file = join(folder, `${name.slice(0, 32)}.json`);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok(undefined);
        return err(error instanceof Error ? error : new Error(String(error)));
      }
      const decoded = decodeSession(text);
      if (!decoded.ok) return err(decoded.error);
      return ok(decoded.value);
    },
    async save(conversation) {
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(file, encodeSession(conversation), "utf8");
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
