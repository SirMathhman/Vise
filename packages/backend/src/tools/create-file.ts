import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";
import type { Approval } from "../chat/approvals";
import { isGitInternal, resolveInside } from "../project/project-files";

/**
 * The name the model uses to call the create-file tool.
 */
export const CREATE_FILE_NAME = "create_file";

/**
 * The tool the model may call. It makes a new file only after the user approves it.
 */
export const CREATE_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: CREATE_FILE_NAME,
    description:
      "Create a new text file in the project. The path must not exist yet, and git must not ignore it. The user approves the new file before it is written.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "New file path relative to the project root.",
        },
        content: {
          type: "string",
          description: "The full text of the new file.",
        },
      },
      required: ["path", "content"],
    },
  },
};

// The longest file the tool will propose.
const MAX_CHARS = 100_000;

const CreateArgumentsSchema = z.object({
  path: z.string(),
  content: z.string().max(MAX_CHARS),
});

// True when the path is a real folder inside the root once symbolic links are followed.
async function folderInside(root: string, absolute: string): Promise<boolean> {
  // Walk up to the nearest folder that exists, so a link cannot lead the write outside.
  let folder = path.dirname(absolute);
  while (!(await stat(folder).catch(() => undefined))) {
    folder = path.dirname(folder);
  }
  const realRoot = await realpath(root);
  const relative = path.relative(realRoot, await realpath(folder));
  return !(
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

// Checks that a new file may be created: inside the project, not ignored by git, not
// already present, and in a folder that stays inside the project.
async function validateNewPath(
  root: string,
  requested: string,
): Promise<Result<string, string>> {
  const relative = resolveInside(root, requested);
  if (!relative.ok) {
    return err(relative.error);
  }
  if (relative.value === "") {
    return err("A new file needs a path inside the project.");
  }
  // Git's own folder runs hooks on the next git command, so nothing may be written there.
  const internal = await isGitInternal(root, relative.value);
  if (!internal.ok) {
    return err(internal.error);
  }
  if (internal.value) {
    return err("Git's own folder cannot be written to.");
  }
  const ignored = await Bun.spawn(
    ["git", "check-ignore", "-q", "--", relative.value],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  ).exited;
  if (ignored === 0) {
    return err(`git ignores "${requested}", so it cannot be created.`);
  }
  if (ignored !== 1) {
    return err("Could not check the git ignore rules.");
  }
  const absolute = path.resolve(root, relative.value);
  if (await stat(absolute).catch(() => undefined)) {
    return err(
      `"${requested}" already exists; this tool never overwrites a file.`,
    );
  }
  if (!(await folderInside(root, absolute))) {
    return err("The folder must stay inside the project.");
  }
  return ok(absolute);
}

/**
 * Proposes one new file for approval. Returns the reason it cannot be proposed as text.
 *
 * @param root The project root.
 * @param argumentsJson The model's arguments, as JSON text.
 * @returns The approval card to show, or the reason the file cannot be created.
 */
export async function runCreateFile(
  root: string,
  argumentsJson: string,
): Promise<string | Approval> {
  const args = parseJson(CreateArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return "The arguments were not valid. Use path and content, and keep content under 100,000 characters.";
  }
  const { path: requested, content } = args.value;
  const checked = await validateNewPath(root, requested);
  if (!checked.ok) {
    return checked.error;
  }
  return {
    title: `Create ${requested}`,
    body: content
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n"),
    apply: async () => {
      // The path may have changed while the user decided, so check again before writing.
      const again = await validateNewPath(root, requested);
      if (!again.ok) {
        return again.error;
      }
      await mkdir(path.dirname(again.value), { recursive: true });
      try {
        // The "wx" flag makes the write fail rather than overwrite a file that appeared.
        await writeFile(again.value, content, { flag: "wx" });
      } catch {
        return `"${requested}" could not be created.`;
      }
      return `Created ${requested}.`;
    },
  };
}
