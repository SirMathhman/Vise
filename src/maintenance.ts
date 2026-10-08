import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { missingBuildOutput } from "./build-check.ts";
import { globalDataDir } from "./data-dir.ts";
import { VERSION } from "./version.ts";

/** Where `--install-extension` writes the Firefox extension. */
export const extensionDir = join(globalDataDir, "extension");

async function installExtension(): Promise<string> {
  const missing = missingBuildOutput("extension/dist/background.js", "bun run build:ext");
  if (missing) {
    process.exitCode = 1;
    return missing;
  }
  const { EXTENSION_FILES } = await import("./extension-assets.ts");
  for (const [name, source] of Object.entries(EXTENSION_FILES)) {
    const target = join(extensionDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, new Uint8Array(await Bun.file(source).arrayBuffer()));
  }
  return `Firefox extension written to ${extensionDir}\nLoad manifest.json through about:debugging (Load Temporary Add-on); after updating Vise, run this again and Reload it there.`;
}

function setupPlaywright(): string {
  const run = spawnSync("npm", ["install", "--prefix", globalDataDir, "playwright-core"], {
    stdio: "inherit",
    shell: true,
  });
  if (run.status !== 0) {
    process.exitCode = 1;
    return "could not install playwright-core: npm failed or is not on the PATH (browser_run_code needs node and npm).";
  }
  return `playwright-core installed in ${globalDataDir}; enable browser_run_code with /tool browser_run_code enable.`;
}

/**
 * The flags that do a job and end the program instead of starting Vise:
 * `--version`, `--install-extension`, `--setup-playwright`. Returns whether one
 * was given (the caller then starts nothing).
 */
export async function runMaintenance(
  argv: string[] = process.argv,
): Promise<boolean> {
  if (argv.includes("--version")) console.log(`vise ${VERSION}`);
  else if (argv.includes("--install-extension"))
    console.log(await installExtension());
  else if (argv.includes("--setup-playwright")) console.log(setupPlaywright());
  else return false;
  return true;
}
