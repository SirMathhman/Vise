import { execFile } from "node:child_process";
import { repoRoot } from "./listing.js";

/**
 * Per-domain leaf module for the process tools: async executors the eval
 * sandbox wires in as built-in functions (see `EVAL_BUILTINS` in
 * evalTools.js). These are NOT standalone LLM-callable tools — they are
 * exposed only inside `eval`, so they carry no OpenAI `definition` block or
 * display metadata. `tools.js` does not import this module.
 */

/**
 * Runs a PowerShell command in the repository root and returns its output
 * plus exit status. Async: resolves to a self-explanatory string the eval
 * expression can await.
 * @param {{ command: string }} args
 * @returns {Promise<string>}
 */
export async function runPowershell({ command }) {
  if (typeof command !== "string" || command.trim() === "") {
    return "Missing required parameter: command.";
  }
  return new Promise((resolve) => {
    execFile(
      "pwsh",
      ["-NoProfile", "-NoLogo", "-Command", command],
      {
        cwd: repoRoot,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const MAX_CHARS = 50_000;
        const out = (stdout || "").trim();
        const errOut = (stderr || "").trim();
        const parts = [];
        if (out) parts.push(out);
        if (errOut) parts.push(`[stderr]\n${errOut}`);
        if (!parts.length) parts.push("(no output)");
        const output = parts.join("\n");
        const body =
          output.length > MAX_CHARS
            ? output.slice(0, MAX_CHARS) +
              `

[truncated: output is ${output.length} characters, showing first ${MAX_CHARS}]`
            : output;
        // execFile's `error.code` is a number only for a real non-zero exit:
        // a timeout gives `code = null, killed = true`, a spawn failure
        // (e.g. pwsh not on PATH) gives `code = "ENOENT"`. Report each
        // distinctly so the model can tell "killed" / "couldn't run" from a
        // genuine failure exit code.
        let suffix = "";
        if (error) {
          if (error.killed) {
            suffix = "\n[timed out after 120s]";
          } else if (typeof error.code !== "number") {
            suffix = `\n[could not run pwsh: ${error.code}]`;
          } else {
            suffix = `\n[exit code: ${error.code}]`;
          }
        }
        resolve(body + suffix);
      },
    );
  });
}

/**
 * Searches the repository's file names by regular expression (case-insensitive)
 * and returns matching relative paths — exactly the files not ignored by
 * .gitignore. Async: resolves to a self-explanatory string the eval
 * expression can await.
 * @param {{ pattern: string }} args
 * @returns {Promise<string>}
 */
export async function searchFiles({ pattern }) {
  if (typeof pattern !== "string" || pattern === "") {
    return "Missing required parameter: pattern.";
  }
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch (err) {
    return `Invalid regex: ${err.message}`;
  }
  // `git ls-files -co --exclude-standard` lists tracked files plus
  // untracked files that are not ignored, pruning .gitignored directories
  // so it stays fast even with node_modules present. -z gives
  // null-delimited paths so names with spaces/newlines are safe.
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-co", "-z", "--exclude-standard"],
      {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          // A timeout (e.g. a held git index lock) gives killed = true, a
          // spawn failure (git not on PATH) gives a non-numeric code.
          const suffix = error.killed
            ? " [timed out after 30s]"
            : typeof error.code !== "number"
              ? ` [could not run git: ${error.code}]`
              : ` [exit code: ${error.code}]`;
          return resolve(`Could not search files${suffix}`);
        }
        const paths = String(stdout).split("\0").filter(Boolean);
        const matches = paths.filter((p) => re.test(p));
        const MAX_RESULTS = 200;
        let body;
        if (matches.length === 0) {
          body = `No files match /${pattern}/i.`;
        } else {
          body = matches.slice(0, MAX_RESULTS).join("\n");
          if (matches.length > MAX_RESULTS) {
            body += `\n\n[truncated: ${matches.length} matches, showing first ${MAX_RESULTS}]`;
          }
        }
        resolve(body);
      },
    );
  });
}
