import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { err, type Result } from "../../core/messages.ts";
import { runInContainer } from "./container-command.ts";
import { ensureContainer, ensureImage, type ContainerSpec } from "./podman.ts";

// The image every session container is made from, built from ./Containerfile on first use.
const IMAGE = "vise-base";
const CONTAINERFILE = join(import.meta.dir, "Containerfile");

// The container a session's commands run in. It is made on the first command, and a command that fails to
// start it is reported; the next command tries again.
export interface SessionContainer {
  // The container's name, for removing it.
  readonly name: string;
  run(command: string): Promise<Result<string>>;
}

export function sessionContainer(folder: string): SessionContainer {
  const spec: ContainerSpec = { name: `vise-${randomUUID().slice(0, 8)}`, folder, image: IMAGE };
  let ready: Promise<Result<void>> | undefined;
  return {
    name: spec.name,
    async run(command) {
      ready ??= prepare(spec);
      const up = await ready;
      if (!up.ok) {
        ready = undefined;
        return err(up.error);
      }
      return runInContainer(spec.name, command);
    },
  };
}

// Builds the image if needed, then makes the session container running.
async function prepare(spec: ContainerSpec): Promise<Result<void>> {
  const image = await ensureImage(IMAGE, CONTAINERFILE, import.meta.dir);
  if (!image.ok) return image;
  return ensureContainer(spec);
}
