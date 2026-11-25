import path from "node:path";
import type { Result } from "common";
import { err, ok } from "common";

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
