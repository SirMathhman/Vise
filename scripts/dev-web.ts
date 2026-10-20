import { $ } from "bun";
import { watch } from "node:fs";

/** Build the browser bundle, then watch browser and server source changes. */
await $`bun run build:web`;

const server = Bun.spawn(["bun", "--watch", "apps/web/src/main.ts"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

let rebuilding = false;
let rebuildQueued = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
const watcher = watch("packages/frontend/src", { recursive: true }, (_event, filename) => {
  if (filename?.toString().endsWith(".ts")) scheduleRebuild();
});
// The page's styles are bundled too (`packages/frontend/src/app.ts` imports `packages/frontend/styles/index.css`).
const styleWatcher = watch("packages/frontend/styles", { recursive: true }, (_event, filename) => {
  if (filename?.toString().endsWith(".css")) scheduleRebuild();
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
  styleWatcher.close();
  if (debounce) clearTimeout(debounce);
}
