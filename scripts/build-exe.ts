import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { rcedit } from "rcedit";
import { installExe } from "./install-exe.ts";
import pkg from "../package.json" with { type: "json" };

/**
 * Build the two executables into `out/`: `vise.exe` (web UI server) and
 * `vise-cli.exe` (terminal REPL). The web bundle and the Firefox extension are
 * built first because the executables embed them. The version printed by
 * `--version` is the package version plus the short git commit.
 */
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
}

/** Change a Windows exe from the console subsystem (3) to the GUI subsystem (2) in its PE header. */
function setGuiSubsystem(file: string): void {
  const bytes = readFileSync(file);
  const header = bytes.readUInt32LE(0x3c);
  const field = header + 0x5c;
  if (bytes.readUInt16LE(field) !== 3)
    throw new Error(`${file}: unexpected subsystem`);
  bytes.writeUInt16LE(2, field);
  writeFileSync(file, bytes);
}

const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
});
const commit = git.status === 0 ? git.stdout.trim() : "unknown";
// A build from uncommitted changes must not share an identity with the commit.
const dirty =
  spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).stdout.trim() !== "";
const version = `${pkg.version}+${commit}${dirty ? "-dirty" : ""}`;

run("bun", ["run", "build:web"]);
run("bun", ["run", "build:ext"]);

for (const [entry, outfile] of [
  ["src/web/main.ts", "out/vise.exe"],
  ["index.ts", "out/vise-cli.exe"],
] as const) {
  // Build beside the real name and swap afterwards: the real file may be the
  // running program (Vise rebuilding itself), which Windows will not overwrite.
  const staged = outfile.replace(/\.exe$/, ".next.exe");
  const result = await Bun.build({
    entrypoints:
      entry === "src/web/main.ts"
        ? [entry, "src/web/desktop/window-worker.ts"]
        : [entry],
    compile: { outfile: staged },
    define: { VISE_VERSION: JSON.stringify(version) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`building ${outfile} failed`);
  }
  // Bun's own `windowsIcon` / `windows.icon` options do not embed anything on this Bun
  // version, so the icon and version strings are written into the exe afterwards.
  await rcedit(staged, {
    icon: "assets/icon.ico",
    "version-string": { ProductName: "Vise", FileDescription: "Vise" },
  });
  // The web exe has a window of its own: mark it a GUI program so no console appears
  // (its output goes to ~/.vise/vise.log; `--version` etc. attach to the launching terminal).
  if (entry === "src/web/main.ts") setGuiSubsystem(staged);
  const keptOld = installExe(staged, outfile);
  console.log(`built ${outfile} (${version})`);
  if (keptOld)
    console.log(
      `  the previous ${outfile} was kept as ${outfile}.<time>.old (removed by a later build); a running copy keeps working until restarted`,
    );
}
