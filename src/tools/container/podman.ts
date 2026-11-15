import { mkdir } from "node:fs/promises";
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
  // Paths under /work that the container cannot write: each is covered by an empty read-only directory. These
  // keep the host's config and hooks out of reach of a command (for example ".vise" and ".git/hooks").
  masks: string[];
  // An empty host directory the masks are taken from. It is created if missing.
  emptyDir: string;
}

const TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 600_000;

// The arguments of `podman run` that create a session container.
export function createArgs(spec: ContainerSpec): string[] {
  const masks = spec.masks.flatMap((mask) => ["-v", `${spec.emptyDir}:/work/${mask}:ro`]);
  return [
    "run",
    "-d",
    "--name",
    spec.name,
    "-v",
    `${spec.folder}:/work`,
    ...masks,
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
export async function podman(args: string[], timeoutMs = TIMEOUT_MS): Promise<Result<PodmanOutput>> {
  try {
    const proc = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
    const limit = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(limit);
    return ok({ code, output: `${stdout}${stderr}` });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// Whether the podman machine answers. The tests that need it are skipped when it does not.
export async function podmanRunning(): Promise<boolean> {
  const version = await podman(["version"]);
  return version.ok && version.value.code === 0;
}

// The names of every container, running or not.
export async function containerNames(): Promise<string[]> {
  const listed = await podman(["ps", "-a", "--format", "{{.Names}}"]);
  if (!listed.ok || listed.value.code !== 0) return [];
  return listed.value.output.split("\n").map((name) => name.trim()).filter((name) => name !== "");
}

// Builds the image from its Containerfile when it is not built yet. A build may take minutes, so it has a
// longer limit than other podman runs.
export async function ensureImage(tag: string, containerfile: string, context: string): Promise<Result<void>> {
  const exists = await podman(["image", "exists", tag]);
  if (!exists.ok) return err(exists.error);
  if (exists.value.code === 0) return ok(undefined);
  return succeeded(await podman(["build", "-t", tag, "-f", containerfile, context], BUILD_TIMEOUT_MS));
}

// Makes sure the session container is running: reuses it when it runs, starts it when it exists stopped, and
// creates it otherwise. A failure is an error.
export async function ensureContainer(spec: ContainerSpec): Promise<Result<void>> {
  try {
    await mkdir(spec.emptyDir, { recursive: true });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  const inspected = await podman(["container", "inspect", "-f", "{{.State.Running}}", spec.name]);
  if (!inspected.ok) return err(inspected.error);
  if (inspected.value.code === 0) {
    if (inspected.value.output.trim() === "true") return ok(undefined);
    return succeeded(await podman(["start", spec.name]));
  }
  return succeeded(await podman(createArgs(spec)));
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

// A podman run that must succeed: its output is the error when it does not.
function succeeded(result: Result<PodmanOutput>): Result<void> {
  if (!result.ok) return err(result.error);
  return result.value.code === 0 ? ok(undefined) : err(new Error(result.value.output.trim()));
}
