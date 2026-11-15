import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../core/messages.ts";
import { killJob } from "../process/jobs.ts";
import { runInContainer } from "./container-command.ts";
import { ensureContainer, execInContainer, podmanRunning, removeContainer, type ContainerSpec } from "./podman.ts";

const available = await podmanRunning();

test.skipIf(!available)("a container command that outlives its timeout is a job, and killing the job stops it inside the container", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-command-"));
  const spec: ContainerSpec = {
    name: `vise-test-${Date.now()}`,
    folder,
    image: "docker.io/library/alpine:latest",
  };
  try {
    expect(await ensureContainer(spec)).toEqual(ok(undefined));
    const started = await runInContainer(spec.name, "sleep 300", 500);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = Number(/job (\d+)/.exec(started.value)?.[1]);
    expect(Number.isInteger(id)).toBe(true);
    expect((await killJob(id)).ok).toBe(true);
    const listed = await execInContainer(spec.name, "ps | grep '[s]leep 300' || echo gone");
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.output).toContain("gone");
  } finally {
    await removeContainer(spec.name);
  }
}, 120_000);
