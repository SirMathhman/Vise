import { lstat } from "node:fs/promises";
import path from "node:path";
import type { Result } from "common";
import { err, ok } from "common";

// The largest project file a tool will open.
const MAX_BYTES = 2_000_000;

// Resolves a requested path against the root. Anything outside the root is refused.
export function resolveInside(
  root: string,
  requested: string,
): Result<string, string> {
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return err("The path must be inside the project");
  }
  return ok(
    relative
      .split(path.sep)
      .filter((part) => part !== "")
      .join("/"),
  );
}

// The files git tracks or would track under root, excluding anything .gitignore matches.
export async function projectFiles(
  root: string,
): Promise<Result<string[], string>> {
  try {
    const proc = Bun.spawn(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      return err("Could not list the project files with git");
    }
    return ok(output.split("\0").filter((file) => file !== ""));
  } catch {
    return err("Could not run git to list the project files");
  }
}

// The git directories of the repository: its own, and the shared one that worktrees use.
async function gitDirectories(root: string): Promise<Result<string[], string>> {
  try {
    const proc = Bun.spawn(
      [
        "git",
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd: root, stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      return err("Could not find the git directory");
    }
    return ok(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
  } catch {
    return err("Could not find the git directory");
  }
}

// True when the relative path lies inside git's own directory, where a written hook would
// run on the next git command.
export async function isGitInternal(
  root: string,
  relative: string,
): Promise<Result<boolean, string>> {
  if (relative.split("/")[0] === ".git") {
    return ok(true);
  }
  const dirs = await gitDirectories(root);
  if (!dirs.ok) {
    return err(dirs.error);
  }
  const absolute = path.resolve(root, relative);
  return ok(
    dirs.value.some((dir) => {
      const inside = path.relative(dir, absolute);
      return (
        inside === "" ||
        (inside !== ".." &&
          !inside.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(inside))
      );
    }),
  );
}

// Opens a project text file for a tool. Refuses anything outside the root, anything git
// ignores, symbolic links, binary files, and files over the size limit.
export async function readProjectText(
  root: string,
  requested: string,
): Promise<Result<{ absolute: string; text: string }, string>> {
  const relative = resolveInside(root, requested);
  if (!relative.ok) {
    return err(relative.error);
  }
  const files = await projectFiles(root);
  if (!files.ok) {
    return err(files.error);
  }
  if (!files.value.includes(relative.value)) {
    return err(
      `"${requested}" is not a file in the project, or git ignores it.`,
    );
  }

  const absolute = path.resolve(root, relative.value);
  const info = await lstat(absolute).catch(() => undefined);
  if (info === undefined) {
    return err("The file could not be read.");
  }
  if (info.isSymbolicLink()) {
    return err("Symbolic links are not followed.");
  }
  if (info.size > MAX_BYTES) {
    return err("The file is too large to read.");
  }
  const bytes = await Bun.file(absolute).bytes();
  if (bytes.includes(0)) {
    return err("The file is binary and cannot be read as text.");
  }
  return ok({ absolute, text: new TextDecoder().decode(bytes) });
}
