import { execFile } from "node:child_process";
import { repoRoot } from "./listing.js";

/**
 * Per-domain tool module for process/file operations (PowerShell execution
 * and file search). Leaf module: imports only listing.js.
 */

const runPowershell = {
  name: "run_powershell",
  label: "Run PowerShell",
  icon: "⚡",
  summary: (args) => args?.command ?? "",
  definition: {
    type: "function",
    function: {
      name: "run_powershell",
      description:
        "Run a PowerShell command in the repository and return its output. " +
        "The working directory is the repository root. Use this to run scripts, " +
        "list or process files, check system state, or any task PowerShell handles. " +
        "Returns the command's output plus its exit code.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              'The PowerShell command or script to run (e.g. "Get-ChildItem src" or "npm run lint:all").',
          },
        },
        required: ["command"],
      },
    },
  },
  async execute(args) {
    if (typeof args?.command !== "string" || args.command.trim() === "") {
      return "Missing required parameter: command.";
    }
    return new Promise((resolve) => {
      execFile(
        "pwsh",
        ["-NoProfile", "-NoLogo", "-Command", args.command],
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
  },
};

const searchFiles = {
  name: "search_files",
  label: "Search files",
  icon: "🔍",
  summary: (args) => args?.pattern ?? "",
  definition: {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search the repository's file names by regular expression, returning " +
        "the relative path of every matching file that is not ignored by " +
        ".gitignore (i.e. files git tracks plus untracked-but-not-ignored " +
        "files). The regex is matched case-insensitively against each file's " +
        "full relative path. Use this to find files by name without listing " +
        "every directory, then read the ones you need. For example, the " +
        'pattern "chat" matches apps/server/chat.js and apps/web/src/chat.js.',
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "A regular expression matched against each file's relative " +
              'path (case-insensitive), e.g. "chat" or ' +
              '"^apps/server/.*\\.js$".',
          },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(args) {
    if (typeof args?.pattern !== "string" || args.pattern === "") {
      return "Missing required parameter: pattern.";
    }
    let re;
    try {
      re = new RegExp(args.pattern, "i");
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
            body = `No files match /${args.pattern}/i.`;
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
  },
};

export { runPowershell, searchFiles };
