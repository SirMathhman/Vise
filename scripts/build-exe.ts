import { spawnSync } from "node:child_process";
import pkg from "../package.json" with { type: "json" };

/**
 * Build the two executables into `out/`: `vise.exe` (web UI server) and
 * `vise-cli.exe` (terminal REPL). The web bundle and the Firefox extension are
 * built first because the executables embed them. The version printed by
 * `--version` is the package version plus the short git commit.
 */
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
});
const commit = git.status === 0 ? git.stdout.trim() : "unknown";
const version = `${pkg.version}+${commit}`;

run("bun", ["run", "build:web"]);
run("bun", ["run", "build:ext"]);

for (const [entry, outfile] of [
  ["src/web/main.ts", "out/vise.exe"],
  ["index.ts", "out/vise-cli.exe"],
] as const) {
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { outfile },
    define: { VISE_VERSION: JSON.stringify(version) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`building ${outfile} failed`);
  }
  console.log(`built ${outfile} (${version})`);
}
