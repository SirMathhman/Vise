import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { missingBuildOutput } from "./build-check.ts";
import { exportAudit } from "../db/audit/audit-export.ts";
import { globalDataDir } from "../data-dir.ts";
import { formatError } from "../output/format.ts";
import { useParentConsole } from "./console.ts";
import { VERSION } from "../version.ts";

/** Where `--install-extension` writes the Firefox extension. */
export const extensionDir = join(globalDataDir, "extension");

async function installExtension(): Promise<string> {
  const missing = missingBuildOutput(
    "apps/extension/dist/background.js",
    "bun run build:ext",
  );
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
  const run = spawnSync(
    "npm",
    ["install", "--prefix", globalDataDir, "playwright-core"],
    {
      stdio: "inherit",
      shell: true,
    },
  );
  if (run.status !== 0) {
    process.exitCode = 1;
    return "could not install playwright-core: npm failed or is not on the PATH (browser_run_code needs node and npm).";
  }
  return `playwright-core installed in ${globalDataDir}; enable browser_run_code with /tool browser_run_code enable.`;
}

/** `--audit-export <id>`: everything recorded for a conversation, as JSON on stdout. */
function auditExport(ref: string | undefined): string {
  if (!ref) {
    process.exitCode = 1;
    return "usage: --audit-export <conversation id> (an id prefix is enough; ids are in the audit_sessions table of ~/.vise/audit.db)";
  }
  const data = exportAudit(ref);
  if (data.ok) return JSON.stringify(data.value, null, 2);
  process.exitCode = 1;
  return formatError(data.error);
}

const MAINTENANCE_FLAGS = [
  "--audit-export",
  "--version",
  "--install-extension",
  "--setup-playwright",
];

/**
 * The flags that do a job and end the program instead of starting Vise:
 * `--version`, `--install-extension`, `--setup-playwright`. Returns whether one
 * was given (the caller then starts nothing).
 */
export async function runMaintenance(
  argv: string[] = process.argv,
): Promise<boolean> {
  if (MAINTENANCE_FLAGS.some((flag) => argv.includes(flag))) useParentConsole();
  if (argv.includes("--version")) console.log(`vise ${VERSION}`);
  else if (argv.includes("--install-extension"))
    console.log(await installExtension());
  else if (argv.includes("--setup-playwright")) console.log(setupPlaywright());
  else if (argv.includes("--audit-export"))
    console.log(auditExport(argv[argv.indexOf("--audit-export") + 1]));
  else return false;
  return true;
}
