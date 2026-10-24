// Builds both executables in release mode and copies them, with an example .env file, into dist/. The web page is built
// first, because the web executable compiles it in.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const run = (command) => execSync(command, { stdio: "inherit" });
const ext = process.platform === "win32" ? ".exe" : "";
const out = "dist";

run("npm run build");
run("cargo build --release --bins");

mkdirSync(out, { recursive: true });
for (const bin of ["vise-repl", "vise-web"]) {
  copyFileSync(join("target", "release", `${bin}${ext}`), join(out, `${bin}${ext}`));
}
writeFileSync(
  join(out, ".env.example"),
  [
    "# Copy this file to .env beside the executables, or into the folder they are started from.",
    "# A variable set in the environment overrides the value here.",
    "VISE_URL=http://127.0.0.1:8080/v1/chat/completions",
    "VISE_MODEL=qwen3.8-flash-next-iq2_xs",
    "VISE_READ_TIMEOUT_SECS=60",
    "",
  ].join("\n"),
);
console.log(`Packaged into ${out}/`);
