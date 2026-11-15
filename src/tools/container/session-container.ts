import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, type Result } from "../../core/messages.ts";
import { runInContainer } from "./container-command.ts";
import { ensureContainer, ensureImage, podman, type ContainerSpec } from "./podman.ts";

// The image every session container is made from, built from ./Containerfile on first use.
const IMAGE = "vise-base";
const CONTAINERFILE = join(import.meta.dir, "Containerfile");
// The empty directory the masks come from. Read-only in the container, so it holds nothing to write.
const EMPTY_DIR = join(tmpdir(), "vise-empty");
// The folder Vise keeps its settings in. Its files are read on the host at start, so a command must not write them.
const SETTINGS_FOLDER = ".vise";

// The container a session's commands run in. It is made on the first command, and a command that fails to
// start it is reported; the next command tries again.
export interface SessionContainer {
  // The container's name, for removing it.
  readonly name: string;
  run(command: string): Promise<Result<string>>;
}

export function sessionContainer(folder: string): SessionContainer {
  const name = `vise-${randomUUID().slice(0, 8)}`;
  let ready: Promise<Result<void>> | undefined;
  return {
    name,
    async run(command) {
      ready ??= prepare(name, folder);
      const up = await ready;
      if (!up.ok) {
        ready = undefined;
        return err(up.error);
      }
      return runInContainer(name, command);
    },
  };
}

// The containers this process made. They are stopped, not removed, when the session ends.
const made = new Set<string>();

// Stops the session containers this process made. A container that cannot be stopped is left as it is.
export async function stopSessionContainers(): Promise<void> {
  for (const name of made) await podman(["stop", "-t", "1", name]);
  made.clear();
}

// Builds the image if needed, then makes the session container running with its masks in place.
async function prepare(name: string, folder: string): Promise<Result<void>> {
  const image = await ensureImage(IMAGE, CONTAINERFILE, import.meta.dir);
  if (!image.ok) return err(image.error);
  const spec: ContainerSpec = {
    name,
    folder,
    image: IMAGE,
    masks: await masksFor(folder),
    emptyDir: EMPTY_DIR,
  };
  const up = await ensureContainer(spec);
  if (up.ok) made.add(name);
  return up;
}

// The paths a command in the container cannot write. ".vise" always. ".git/hooks" only when the folder is a
// repository: podman creates a missing mount point on the host, and that would make a plain folder a repository.
async function masksFor(folder: string): Promise<string[]> {
  return (await isDirectory(join(folder, ".git"))) ? [SETTINGS_FOLDER, ".git/hooks"] : [SETTINGS_FOLDER];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
