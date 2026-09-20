import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { badRequest } from "../../errors.js";

/**
 * Runs a model-written Playwright snippet for browser_run_code, contained.
 *
 * The snippet is arbitrary text from the model, so it must not run inside the
 * backend process: a synchronous loop would freeze the whole server (no timer
 * could fire to stop it), and it would have the backend's full Node privileges
 * (files, child processes) — bypassing the filesystem sandbox the other tools
 * go through. Instead it runs in a short-lived child Node process started with
 * `--permission`, which grants no file reads outside Playwright's own package,
 * no writes outside a fresh empty scratch directory, and no child processes or
 * workers. The child gets its `page` by attaching to the same Chrome over CDP
 * (the network permission is what that needs). On timeout the child is killed,
 * so a hung or spinning snippet is actually stopped.
 */

/** How long a snippet may run before its process is killed. */
const CODE_TIMEOUT_MS = 30_000;

/** Marks the child's one result line among any output the snippet itself prints. */
const RESULT_MARK = "@@VISE_RESULT@@";

/**
 * The child's whole program, run with `node --input-type=module -e`. It reads
 * `{ playwright, cdp, code }` from stdin, runs the snippet as an async
 * function body with `page` in scope, and prints one marked JSON line.
 */
const CHILD_SOURCE = `
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { playwright, cdp, code } = JSON.parse(Buffer.concat(chunks).toString());
const finish = (result) =>
  process.stdout.write("\\n${RESULT_MARK}" + JSON.stringify(result) + "\\n", () => process.exit(0));
try {
  const mod = await import(playwright);
  const chromium = mod.chromium ?? mod.default.chromium;
  const browser = await chromium.connectOverCDP(cdp);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error("the browser page is gone");
  // With no listener Playwright would auto-dismiss dialogs; leave them open
  // for the backend's own watch to hold and the model to answer.
  page.on("dialog", () => {});
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const value = await new AsyncFunction("page", code)(page);
  let shown;
  try {
    shown = value === undefined ? "undefined" : JSON.stringify(value);
  } catch {
    shown = String(value);
  }
  finish({ ok: true, shown });
} catch (err) {
  finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`;

/** Where Playwright's own package lives, the one place the child may read. */
function playwrightPaths(): { dir: string; entry: string } {
  return {
    dir: dirname(require.resolve("playwright-core/package.json")),
    entry: pathToFileURL(require.resolve("playwright-core")).href,
  };
}

/**
 * Run `code` (an async function body with `page` in scope) against the page
 * served at `cdpEndpoint`, and return its JSON-serialized return value.
 * Throws a model-readable badRequest if the snippet throws, times out, or the
 * process dies.
 */
export async function runSnippet(
  cdpEndpoint: string,
  code: string
): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "vise-code-"));
  const { dir, entry } = playwrightPaths();
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--permission",
          "--allow-net",
          `--allow-fs-read=${dir}`,
          `--allow-fs-read=${scratch}`,
          `--allow-fs-write=${scratch}`,
          "--disable-warning=ExperimentalWarning",
          "--input-type=module",
          "-e",
          CHILD_SOURCE,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch },
        }
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(
          badRequest(
            `code did not finish within ${CODE_TIMEOUT_MS / 1000}s and was stopped`
          )
        );
      }, CODE_TIMEOUT_MS);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(badRequest(`could not start the code runner: ${e.message}`));
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        const line = out
          .split("\n")
          .reverse()
          .find((l) => l.startsWith(RESULT_MARK));
        if (!line) {
          reject(
            badRequest(
              `code runner exited (${exitCode}) without a result${err.trim() ? `: ${err.trim().slice(0, 500)}` : ""}`
            )
          );
          return;
        }
        const result = JSON.parse(line.slice(RESULT_MARK.length)) as
          | { ok: true; shown: string }
          | { ok: false; error: string };
        if (result.ok) resolve(result.shown);
        else reject(badRequest(`code threw: ${result.error}`));
      });
      child.stdin.end(
        JSON.stringify({ playwright: entry, cdp: cdpEndpoint, code })
      );
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
