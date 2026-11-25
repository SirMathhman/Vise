import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Result } from "common";
import { err, ok } from "common";
import { runCaptured } from "../process/run";

/**
 * The image commands run in. Build it with `bun run sandbox:build`.
 */
export const SANDBOX_IMAGE = "localhost/vise-sandbox:1";

// Files that hold secrets. Each is hidden behind an empty, read-only file in the sandbox.
const SECRET_FILES = ["packages/backend/.env"];

// Time podman gets to start and remove a container, on top of the command's own limit.
const PODMAN_GRACE_MS = 15_000;

/**
 * The podman command that runs one shell command in a throwaway container. Only the project is
 * mounted, read-write at /workspace. Secrets are masked, no host environment reaches the
 * container, and `timeout` inside it ends the whole process tree.
 *
 * @param root The project folder to mount.
 * @param name The container name, used to remove it if needed.
 * @param command The bash command to run.
 * @param timeoutSeconds The time limit the container's timeout enforces.
 * @returns The podman command as a list of arguments.
 */
export function sandboxArguments(
  root: string,
  name: string,
  command: string,
  timeoutSeconds: number,
): string[] {
  const masks = SECRET_FILES.filter((file) =>
    existsSync(path.join(root, file)),
  ).flatMap((file) => ["-v", `/dev/null:/workspace/${file}:ro`]);
  return [
    "podman",
    "run",
    "--rm",
    "--name",
    name,
    "--cap-drop=all",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${root}:/workspace`,
    ...masks,
    "-w",
    "/workspace",
    SANDBOX_IMAGE,
    "timeout",
    "--kill-after=2",
    String(timeoutSeconds),
    "bash",
    "-c",
    command,
  ];
}

/**
 * Runs one shell command in the sandbox and returns its exit code and output. It never falls
 * back to running on this machine.
 *
 * @param root The project folder to mount.
 * @param command The bash command to run.
 * @param timeoutMs How long the command may run.
 * @returns The exit code and output, or an error when the sandbox could not run the command.
 */
export async function executeInSandbox(
  root: string,
  command: string,
  timeoutMs: number,
): Promise<Result<string, string>> {
  const name = `vise-command-${randomUUID()}`;
  const seconds = Math.ceil(timeoutMs / 1000);
  const result = await runCaptured(
    sandboxArguments(root, name, command, seconds),
    root,
    timeoutMs + PODMAN_GRACE_MS,
  );
  if (!result.ok) {
    // Podman itself did not finish in time, so make sure the container is gone.
    try {
      Bun.spawn(["podman", "rm", "-f", name], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // Podman is not reachable; there is no container to remove.
    }
    return result;
  }
  const { code, output } = result.value;
  if (code === 125) {
    return err(
      `The sandbox could not start. Check that podman is running and that the image is built with bun run sandbox:build.\n${output}`,
    );
  }
  const status =
    code === 124
      ? `Exit code 124 (stopped after ${String(seconds)} seconds)`
      : `Exit code ${String(code)}`;
  return ok(`${status}\n${output}`);
}
