import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolRunner } from "./core/engine.ts";
import {
  deleteNote,
  findNoteKind,
  formatNoteEntry,
  listNotes,
  readNote,
  saveNote,
} from "./notes.ts";

/** Tool definitions exposed to the model. */
export const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the files and directories in a given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (default '.')",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file from a given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to read",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a new file at the given path with the given contents. Parent directories are created as needed. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to create",
          },
          content: {
            type: "string",
            description: "Contents to write to the file. May be empty.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace the exact (unique) occurrence of old_string in a file with new_string. The file can be of arbitrary length; only the changed portion is provided, so the whole file need not be reproduced. old_string must match exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to edit",
          },
          old_string: {
            type: "string",
            description:
              "Exact literal text to find and replace. Must appear exactly once and must not be empty.",
          },
          new_string: {
            type: "string",
            description:
              "Exact literal text to replace old_string with. May be empty to delete.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete the file at the given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to delete",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_directory",
      description:
        "Delete the directory at the given path and everything inside it",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the directory to delete",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_powershell",
      description:
        "Run a PowerShell command and return its combined stdout/stderr output. Runs in the current working directory.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The PowerShell command to run",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description:
        "List all notes (memories and skills) with their one-line summaries. Notes are short facts (memory) or how-to procedures (skill) stored for this project. Use this to see what is known before relying on or writing a note. Optional 'kind' filters to 'memory' or 'skill'.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description:
              "Optional filter: 'memory' or 'skill'. Omit to list both.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description:
        "Read the full body of a note by name. Searches both memory and skill notes. Call list_notes first to see what is available.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the note to read",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_note",
      description:
        "Save a new note for this project. The first line of body becomes the note's one-line summary (shown in list_notes); the rest is the body. Names must be unique across both kinds, so a name already used by a memory cannot be reused by a skill and vice versa.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description:
              "Note kind: 'memory' (a fact) or 'skill' (a procedure)",
          },
          name: {
            type: "string",
            description:
              "Short unique name for the note (becomes the filename)",
          },
          body: {
            type: "string",
            description:
              "Note contents. The first non-empty line is its summary.",
          },
        },
        required: ["kind", "name", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description:
        "Delete a note by name. Searches both memory and skill notes. Use with care.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the note to delete",
          },
        },
        required: ["name"],
      },
    },
  },
];

/** Edge-provided tool implementations. All I/O is here; the core only
 * depends on the ToolRunner type.
 */

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function listDirectory(args: Record<string, unknown>): string {
  try {
    const entries = readdirSync(String(args.path ?? "."));
    return entries.join("\n");
  } catch (err) {
    return errStr(err);
  }
}

function readFile(args: Record<string, unknown>): string {
  try {
    return readFileSync(String(args.path ?? ""), "utf8");
  } catch (err) {
    return errStr(err);
  }
}

function createFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path must not be empty`;
  try {
    if (existsSync(path)) {
      return `error: ${path} already exists; use edit_file to modify it`;
    }
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path, String(args.content ?? ""), "utf8");
    } catch (err) {
      // The open succeeded (file now exists, possibly empty/partial).
      // Remove it so a retry isn't told "already exists" for a file
      // this tool just made.
      try {
        unlinkSync(path);
      } catch {
        // File may not exist; the original error is what matters.
      }
      throw err;
    }
    return `created ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

function editFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  const old = String(args.old_string ?? "");
  const next = String(args.new_string ?? "");
  try {
    if (old === "") {
      return `error: old_string must not be empty in ${path}`;
    }
    const current = readFileSync(path, "utf8");
    const count = current.split(old).length - 1;
    if (count === 0) {
      return `error: old_string not found in ${path}`;
    }
    if (count > 1) {
      return `error: old_string appears ${count} times in ${path}; it must be unique`;
    }
    writeFileSync(path, current.replace(old, next), "utf8");
    return `edited ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

function deleteFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path must not be empty`;
  try {
    unlinkSync(path);
    return `deleted ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

function deleteDirectory(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path must not be empty`;
  try {
    rmSync(path, { recursive: true });
    return `deleted ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

async function runPowershell(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? "");
  if (command === "") return `error: command must not be empty`;
  try {
    const res = await new Promise<{
      status: number;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, 60_000);
      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      proc.on("close", (status) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ status: -1, stdout, stderr });
        } else {
          resolve({ status: status ?? -1, stdout, stderr });
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const exitCode = res.status;
    const stdout = res.stdout;
    const stderr = res.stderr;
    const body = [stdout.trim(), stderr.trim()]
      .filter((s) => s !== "")
      .join("\n");
    if (exitCode !== 0) {
      return `exit code ${exitCode}\n${body}`.trim();
    }
    return body;
  } catch (err) {
    return errStr(err);
  }
}

function listNotesTool(args: Record<string, unknown>): string {
  const kind = args.kind === undefined ? undefined : String(args.kind);
  if (kind !== undefined && kind !== "memory" && kind !== "skill") {
    return `error: kind must be 'memory' or 'skill'`;
  }
  try {
    const notes = listNotes(process.cwd());
    const filtered =
      kind === undefined ? notes : notes.filter((n) => n.kind === kind);
    if (filtered.length === 0) return "no notes";
    return filtered.map(formatNoteEntry).join("\n");
  } catch (err) {
    return errStr(err);
  }
}

function readNoteTool(args: Record<string, unknown>): string {
  const noteName = String(args.name ?? "");
  try {
    const kind = findNoteKind(process.cwd(), noteName);
    if (kind === undefined) {
      return `error: note '${noteName}' not found`;
    }
    return readNote(process.cwd(), kind, noteName) ?? "";
  } catch (err) {
    return errStr(err);
  }
}

function saveNoteTool(args: Record<string, unknown>): string {
  const kind = String(args.kind ?? "");
  const noteName = String(args.name ?? "");
  const body = String(args.body ?? "");
  if (kind !== "memory" && kind !== "skill") {
    return `error: kind must be 'memory' or 'skill'`;
  }
  try {
    saveNote(process.cwd(), kind, noteName, body);
    return `saved ${kind} note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}

function deleteNoteTool(args: Record<string, unknown>): string {
  const noteName = String(args.name ?? "");
  try {
    const kind = deleteNote(process.cwd(), noteName);
    return `deleted ${kind} note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}

const toolHandlers: Record<
  string,
  (args: Record<string, unknown>) => string | Promise<string>
> = {
  list_directory: listDirectory,
  read_file: readFile,
  create_file: createFile,
  edit_file: editFile,
  delete_file: deleteFile,
  delete_directory: deleteDirectory,
  run_powershell: runPowershell,
  list_notes: listNotesTool,
  read_note: readNoteTool,
  save_note: saveNoteTool,
  delete_note: deleteNoteTool,
};

export const toolRunner: ToolRunner = {
  async run(name, args): Promise<string> {
    const handler = toolHandlers[name];
    if (handler === undefined) {
      return `error: unknown tool ${name}`;
    }
    return handler(args);
  },
};
