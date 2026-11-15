import { err, ok, type Result } from "../../core/messages.ts";

// The session container: named, with only the working folder mounted (read-write), no network, no new
// privileges, and no Linux capabilities. It sleeps until removed, and commands run in it with `podman exec`.
// Memory, CPU, and process limits are not set: the WSL podman machine does not expose the cgroup controllers
// they need (checked: "controller cpu/pids is not available", "memory.max: No such file").
export interface ContainerSpec {
  name: string;
  // The Windows folder mounted at /work.
  folder: string;
  image: string;
}

const TIMEOUT_MS = 60_000;

// The arguments of `podman run` that create a session container.
export function createArgs(spec: ContainerSpec): string[] {
  return [
    "run",
    "-d",
    "--name",
    spec.name,
    "-v",
    `${spec.folder}:/work`,
    "-w",
    "/work",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    spec.image,
    "sleep",
    "infinity",
  ];
}

interface PodmanOutput {
  code: number;
  output: string;
}

// Runs `podman` with these arguments, with no shell, and returns its exit code and output. A run that
// outlives the timeout is killed and reported as a failure.
export async function podman(args: string[]): Promise<Result<PodmanOutput>> {
  try {
    const proc = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    return ok({ code, output: `${stdout}${stderr}` });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// Makes sure the session container is running: reuses it when it runs, starts it when it exists stopped, and
// creates it otherwise. A failure is an error.
export async function ensureContainer(spec: ContainerSpec): Promise<Result<void>> {
  const inspected = await podman(["container", "inspect", "-f", "{{.State.Running}}", spec.name]);
  if (!inspected.ok) return err(inspected.error);
  if (inspected.value.code === 0) {
    if (inspected.value.output.trim() === "true") return ok(undefined);
    return started(await podman(["start", spec.name]));
  }
  return started(await podman(createArgs(spec)));
}

// Runs a shell command in the container, in /work, and returns its exit code and output.
export async function execInContainer(name: string, command: string): Promise<Result<PodmanOutput>> {
  return podman(["exec", "-w", "/work", name, "sh", "-c", command]);
}

// Removes the container, and everything in it that is not in the mounted folder.
export async function removeContainer(name: string): Promise<Result<void>> {
  const removed = await podman(["rm", "-f", name]);
  if (!removed.ok) return err(removed.error);
  return removed.value.code === 0 ? ok(undefined) : err(new Error(removed.value.output.trim()));
}

function started(result: Result<PodmanOutput>): Result<void> {
  if (!result.ok) return err(result.error);
  return result.value.code === 0 ? ok(undefined) : err(new Error(result.value.output.trim()));
}
