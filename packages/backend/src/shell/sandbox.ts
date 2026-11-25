import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { BackgroundJob } from "../process/jobs";
import { startBackground } from "../process/jobs";

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
 * Starts one shell command in the sandbox as a background job. It never falls back to running on
 * this machine. The container's own limit ends the command, and the job's limit backs it up.
 *
 * @param root The project folder to mount.
 * @param command The bash command to run.
 * @param lifetimeMs How long the command may run in total.
 * @returns The running job, whose output is read as it arrives.
 */
export function startSandboxCommand(
  root: string,
  command: string,
  lifetimeMs: number,
): BackgroundJob {
  const name = `vise-command-${randomUUID()}`;
  const seconds = Math.ceil(lifetimeMs / 1000);
  return startBackground(
    sandboxArguments(root, name, command, seconds),
    root,
    lifetimeMs + PODMAN_GRACE_MS,
    name,
  );
}
