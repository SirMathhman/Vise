import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../core/messages.ts";
import { ensureContainer, execInContainer, podmanRunning, removeContainer, type ContainerSpec } from "./podman.ts";

// The tests need the podman machine running; without it they are skipped.
const available = await podmanRunning();

test.skipIf(!available)("a session container runs commands in the folder, and what it writes reaches the folder", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-container-"));
  const spec: ContainerSpec = {
    name: `vise-test-${Date.now()}`,
    folder,
    image: "docker.io/library/alpine:latest",
  };
  try {
    expect(await ensureContainer(spec)).toEqual(ok(undefined));
    const run = await execInContainer(spec.name, "echo made > made.txt && cat made.txt");
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.value.output.trim()).toBe("made");
    expect(await readFile(join(folder, "made.txt"), "utf8")).toBe("made\n");
    // A second ensure reuses the running container.
    expect(await ensureContainer(spec)).toEqual(ok(undefined));
    const again = await execInContainer(spec.name, "echo still-here");
    expect(again.ok && again.value.output.trim()).toBe("still-here");
  } finally {
    await removeContainer(spec.name);
  }
}, 120_000);
