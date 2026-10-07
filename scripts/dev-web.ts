import { $ } from "bun";
import { watch } from "node:fs";

/** Build the browser bundle, then watch browser and server source changes. */
await $`bun run build:web`;

const server = Bun.spawn(["bun", "--watch", "src/web/main.ts"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

let rebuilding = false;
let rebuildQueued = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
const watcher = watch("web/src", { recursive: true }, (_event, filename) => {
  if (filename?.toString().endsWith(".ts")) scheduleRebuild();
});

function scheduleRebuild(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (rebuilding) {
      rebuildQueued = true;
      return;
    }
    rebuilding = true;
    void (async () => {
      do {
        rebuildQueued = false;
        try {
          await $`bun run build:web`;
        } catch (error) {
          console.error("web bundle rebuild failed:", error);
        }
      } while (rebuildQueued);
      rebuilding = false;
    })();
  }, 75);
}

try {
  await server.exited;
} finally {
  watcher.close();
  if (debounce) clearTimeout(debounce);
}
