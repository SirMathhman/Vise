import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolNames } from "../../core/tools.ts";
import { runTool } from "../run-tool.ts";
import { containerNames, podman, podmanRunning, removeContainer } from "./podman.ts";
import { sessionContainer, stopSessionContainers } from "./session-container.ts";

// The tests need the podman machine running; without it they are skipped. The first run builds the image,
// which needs the network, so these tests have a long limit.
const available = await podmanRunning();
const LONG = 900_000;

test.skipIf(!available)("a session container has git, runs commands in the folder, and keeps running between commands", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-session-"));
  const container = sessionContainer(folder);
  try {
    const first = await container.run("git --version && echo made > made.txt");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toContain("git version");
    expect(await readFile(join(folder, "made.txt"), "utf8")).toBe("made\n");
    const second = await container.run("echo again");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toContain("again");
    // Ending the session stops the container, and does not remove it.
    await stopSessionContainers();
    const state = await podman(["container", "inspect", "-f", "{{.State.Running}}", container.name]);
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.value.output.trim()).toBe("false");
  } finally {
    await removeContainer(container.name);
  }
}, LONG);

test.skipIf(!available)("an unattended run_powershell runs in the session container after approval", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vise-session-"));
  const before = new Set(await containerNames());
  const asked: string[] = [];
  try {
    const result = await runTool(folder, undefined, undefined, true)(
      { id: "p1", name: "run_powershell", arguments: '{"command":"echo routed; uname -s"}' },
      async (preview) => {
        asked.push(preview);
        return true;
      },
      toolNames,
    );
    expect(asked.length).toBe(1);
    expect(result).toContain("routed");
    expect(result).toContain("Linux");
  } finally {
    for (const name of await containerNames()) {
      if (name.startsWith("vise-") && !before.has(name)) await removeContainer(name);
    }
  }
}, LONG);
