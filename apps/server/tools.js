import { writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { getListing, getFileContent, repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";
import {
  upsertNote,
  searchNotes,
  listNotes,
} from "./notes.js";

/**
 * A tool the model can call. Its definition (sent to the LLM) and executor
 * (run server-side) live together so the tool contract is defined exactly
 * once. Adding a tool is a single-file change.
 */
const listDirectory = {
  name: "list_directory",
  label: "List directory",
  icon: "📁",
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List the files and subdirectories in a directory of the repository. " +
        "Use an empty path to list the repository root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory path relative to the repository root (e.g. "apps/server"). Empty string for the root.',
          },
        },
        required: ["path"],
      },
    },
  },
  async execute(args) {
    const dir = resolveWithin(repoRoot, args?.path ?? "");
    if (!dir) return "Invalid path (must be within the repository).";
    try {
      const entries = await getListing(dir);
      return entries
        .map((e) => `${e.isDirectory ? "dir " : "file"} ${e.name}`)
        .join("\n");
    } catch (err) {
      return `Could not list directory: ${err.message}`;
    }
  },
};

const readFile = {
  name: "read_file",
  label: "Read file",
  icon: "📄",
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the text content of a file in the repository. " +
        "Use this to answer questions about what a file contains.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path relative to the repository root (e.g. "apps/server/chat.js").',
          },
        },
        required: ["path"],
      },
    },
  },
  async execute(args) {
    const file = resolveWithin(repoRoot, args?.path ?? "");
    if (!file) return "Invalid path (must be within the repository).";
    try {
      const content = await getFileContent(file);
      const MAX_CHARS = 100_000;
      if (content.length > MAX_CHARS) {
        return (
          content.slice(0, MAX_CHARS) +
          `\n\n[truncated: file is ${content.length} characters, showing first ${MAX_CHARS}]`
        );
      }
      return content;
    } catch (err) {
      return `Could not read file: ${err.message}`;
    }
  },
};

const createFile = {
  name: "create_file",
  label: "Create file",
  icon: "📝",
  writesFile: true,
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a new file in the repository. " +
        "Fails if the file already exists. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path relative to the repository root (e.g. "apps/server/chat.js").',
          },
          content: {
            type: "string",
            description: "The content to write to the new file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args) {
    const file = resolveWithin(repoRoot, args?.path ?? "");
    if (!file)
      return { result: "Invalid path (must be within the repository)." };
    if (typeof args?.content !== "string")
      return { result: "Missing required parameter: content." };
    try {
      await stat(file);
      return { result: `File already exists: ${args.path}` };
    } catch (err) {
      if (err.code !== "ENOENT")
        return { result: `Could not create file: ${err.message}` };
    }
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, args.content, "utf8");
      return {
        result: `Created ${args.path} (${args.content.length} characters).`,
        file: { path: args.path, content: args.content },
      };
    } catch (err) {
      return { result: `Could not create file: ${err.message}` };
    }
  },
};

const createDirectory = {
  name: "create_directory",
  label: "Create directory",
  icon: "📂",
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "create_directory",
      description:
        "Create a new directory in the repository. " +
        "Fails if the path already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory path relative to the repository root (e.g. "apps/server/utils").',
          },
        },
        required: ["path"],
      },
    },
  },
  async execute(args) {
    const dir = resolveWithin(repoRoot, args?.path ?? "");
    if (!dir) return "Invalid path (must be within the repository).";
    try {
      const info = await stat(dir);
      if (info.isDirectory()) return `Directory already exists: ${args.path}`;
      return `A file with this name already exists: ${args.path}`;
    } catch (err) {
      if (err.code !== "ENOENT")
        return `Could not create directory: ${err.message}`;
    }
    try {
      await mkdir(dir, { recursive: true });
      return `Created directory ${args.path}.`;
    } catch (err) {
      return `Could not create directory: ${err.message}`;
    }
  },
};

const editFile = {
  name: "edit_file",
  label: "Edit file",
  icon: "✏️",
  writesFile: true,
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Modify an existing file in the repository. " +
        "Fails if the file does not exist. Read the file first to see its current content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path relative to the repository root (e.g. "apps/server/chat.js").',
          },
          content: {
            type: "string",
            description: "The full new content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args) {
    const file = resolveWithin(repoRoot, args?.path ?? "");
    if (!file)
      return { result: "Invalid path (must be within the repository)." };
    if (typeof args?.content !== "string")
      return { result: "Missing required parameter: content." };
    try {
      const info = await stat(file);
      if (!info.isFile())
        return { result: `File does not exist: ${args.path}` };
      await writeFile(file, args.content, "utf8");
      return {
        result: `Edited ${args.path} (${args.content.length} characters).`,
        file: { path: args.path, content: args.content },
      };
    } catch (err) {
      if (err.code === "ENOENT")
        return { result: `File does not exist: ${args.path}` };
      return { result: `Could not edit file: ${err.message}` };
    }
  },
};

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

const takeNote = {
  name: "take_note",
  label: "Take note",
  icon: "📌",
  summary: (args) => args?.title ?? "",
  definition: {
    type: "function",
    function: {
      name: "take_note",
      description:
        "Record a note in the agent's persistent notes store. A note is a " +
        "consolidation of what you currently understand about a topic — a " +
        "fact, decision, or plan — written in your own words, not a copy of " +
        "the conversation. Use this when the user asks you to remember or " +
        "take a note, or when you learn something durable that should survive " +
        "the current conversation. Notes are stored outside the repository. " +
        "A note with an existing title (case-insensitive) is updated in place " +
        "with the new content; a new title adds a note. Call recall_notes " +
        "after taking a note only if the user asks for it back.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "A short title for the note, describing its topic (e.g. " +
              '"Deploy target" or "User preference: dark mode").',
          },
          content: {
            type: "string",
            description:
              "The note's body: your consolidated understanding in a few " +
              "sentences, specific and self-contained so it makes sense on " +
              "its own later.",
          },
        },
        required: ["title", "content"],
      },
    },
  },
  async execute(args) {
    if (typeof args?.title !== "string" || args.title.trim() === "") {
      return "Missing required parameter: title.";
    }
    if (typeof args?.content !== "string" || args.content.trim() === "") {
      return "Missing required parameter: content.";
    }
    try {
      const { note, updated } = await upsertNote(args.title, args.content);
      return updated
        ? `Updated note: ${note.title} (${note.content.length} characters).`
        : `Took note: ${note.title} (${note.content.length} characters).`;
    } catch (err) {
      return `Could not take note: ${err.message}`;
    }
  },
};

const recallNotes = {
  name: "recall_notes",
  label: "Recall notes",
  icon: "🧠",
  summary: (args) => (args?.pattern ? `"${args.pattern}"` : "all"),
  definition: {
    type: "function",
    function: {
      name: "recall_notes",
      description:
        "Recall the agent's persistent notes. With no pattern, lists every " +
        "stored note. With a pattern, returns only notes whose title or " +
        "content matches the case-insensitive regex. Use this to answer " +
        "questions from what was previously noted, or to check existing notes " +
        "before taking a new one.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              'Optional regex matched case-insensitively against each note\'s ' +
              'title and content (e.g. "deploy" or "^.*target$").',
          },
        },
      },
    },
  },
  async execute(args) {
    let results;
    if (args?.pattern) {
      let re;
      try {
        re = new RegExp(args.pattern, "i");
      } catch (err) {
        return `Invalid regex: ${err.message}`;
      }
      results = await searchNotes(re);
    } else {
      results = await listNotes();
    }
    const MAX_RESULTS = 50;
    const MAX_NOTE_CHARS = 500;
    const lines = results.slice(0, MAX_RESULTS).map((n) => {
      const body =
        n.content.length > MAX_NOTE_CHARS
          ? n.content.slice(0, MAX_NOTE_CHARS) + "…"
          : n.content;
      return `${n.title}\n${body}`;
    });
    if (results.length === 0) {
      return args?.pattern
        ? `No notes match /${args.pattern}/i.`
        : "No notes stored yet.";
    }
    const header =
      results.length > MAX_RESULTS
        ? `Found ${results.length} notes, showing first ${MAX_RESULTS}:\n\n`
        : `Found ${results.length} note${results.length === 1 ? "" : "s"}:\n\n`;
    return header + lines.join("\n\n");
  },
};

/**
 * The registry of tools available to the model.
 */
export const TOOLS = [
  listDirectory,
  readFile,
  createFile,
  createDirectory,
  editFile,
  runPowershell,
  searchFiles,
  takeNote,
  recallNotes,
]; 
