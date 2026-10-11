import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * The web UI's git panel: the working tree's state, and staging and committing
 * in the session's folder, run directly (never through a model turn). Only a
 * session with a folder has one; paths are the repository's and must lie inside it.
 * Wire protocol (JSON):
 *   browser → server: { type:"git_status" }
 *                     { type:"git_stage", paths:[...] }  { type:"git_unstage", paths:[...] }
 *                     { type:"git_commit", message }
 *   server → browser: { type:"git_status", ok, repo, prefix?, branch?, ahead?, behind?, staged, changed, untracked, error? }
 *                     { type:"git_result", ok, action, error?, output? }   after a stage, unstage or commit
 */

type Reply = Record<string, unknown>;

/** A file in the status: its path (relative to the repository) and its one-letter state. */
export interface GitFile {
  path: string;
  /** M modified, A added, D deleted, R renamed, C copied, U conflicted, ? untracked. */
  code: string;
}

export interface GitStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  staged: GitFile[];
  changed: GitFile[];
  untracked: GitFile[];
}

/** The branch line: `## main...origin/main [ahead 1, behind 2]` or `## No commits yet on main`. */
function parseBranch(line: string, status: GitStatus): void {
  const head = line.slice(3);
  const fresh = /^No commits yet on (.+)$/.exec(head);
  if (fresh) {
    status.branch = fresh[1];
    return;
  }
  const name = /^(.+?)(?:\.\.\.\S+)?(?: \[(.+)\])?$/.exec(head);
  status.branch = name?.[1] ?? head;
  const counts = name?.[2] ?? "";
  const ahead = /ahead (\d+)/.exec(counts);
  const behind = /behind (\d+)/.exec(counts);
  if (ahead) status.ahead = Number(ahead[1]);
  if (behind) status.behind = Number(behind[1]);
}

/**
 * Parse `git status --porcelain=v1 --branch -z`: NUL-separated entries
 * `XY path`, where X is the index's state and Y the working tree's; a rename
 * or copy is followed by its old path as a separate entry. Pure.
 */
export function parseStatus(text: string): GitStatus {
  const status: GitStatus = { staged: [], changed: [], untracked: [] };
  const entries = text.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.startsWith("## ")) {
      parseBranch(entry, status);
      continue;
    }
    if (entry.length < 4) continue;
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const path = entry.slice(3);
    if (x === "R" || x === "C") i++; // skip the old path
    if (x === "?" && y === "?") {
      status.untracked.push({ path, code: "?" });
      continue;
    }
    const conflicted = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (conflicted) {
      status.changed.push({ path, code: "U" });
      continue;
    }
    if (x !== " ") status.staged.push({ path, code: x });
    if (y !== " ") status.changed.push({ path, code: y });
  }
  return status;
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) return { ok: false, out: result.error.message };
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return { ok: result.status === 0, out };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) };
  }
}

/** The paths of a message, each checked to lie inside the root; null when any does not. */
function insidePaths(root: string, value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") return null;
    const rel = relative(root, resolve(root, item));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    paths.push(rel);
  }
  return paths;
}

/** The repository's top folder, or null when the root is not in one. */
function topLevel(root: string): string | null {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  return top.ok && top.out ? resolve(top.out) : null;
}

function statusReply(root: string): Reply {
  const top = topLevel(root);
  if (!top) return { type: "git_status", ok: true, repo: false, staged: [], changed: [], untracked: [] };
  const result = git(top, ["status", "--porcelain=v1", "--branch", "-z", "-uall"]);
  if (!result.ok) return { type: "git_status", ok: false, repo: true, error: result.out };
  // Status paths are the repository's; `prefix` is where the session's folder sits in it, so the page can open them.
  const prefix = relative(top, root).replaceAll("\\", "/");
  return { type: "git_status", ok: true, repo: true, prefix, ...parseStatus(result.out) };
}

function action(root: string, cwd: string, name: string, args: string[]): Reply[] {
  const result = git(cwd, args);
  const reply: Reply = { type: "git_result", ok: result.ok, action: name };
  if (result.ok) reply["output"] = result.out;
  else reply["error"] = result.out || `git ${name} failed`;
  return [reply, statusReply(root)];
}

/** Handle a git panel message for a session rooted at `root`; null when it is not one. */
export function handleGitMessage(
  root: string,
  noFolder: boolean,
  msg: Record<string, unknown>,
): Reply[] | null {
  const type = msg["type"];
  if (typeof type !== "string" || !type.startsWith("git_")) return null;
  if (noFolder) return [{ type: "git_result", ok: false, action: type, error: "this session has no folder" }];
  if (type === "git_status") return [statusReply(root)];
  if (type === "git_commit") {
    const message = typeof msg["message"] === "string" ? msg["message"].trim() : "";
    if (!message) return [{ type: "git_result", ok: false, action: "commit", error: "a commit needs a message" }];
    return action(root, root, "commit", ["commit", "-m", message]);
  }
  if (type !== "git_stage" && type !== "git_unstage") return null;
  // The panel names files as the status does: relative to the repository's top folder.
  const top = topLevel(root);
  const paths = top ? insidePaths(top, msg["paths"]) : null;
  if (!top || !paths) return [{ type: "git_result", ok: false, action: type, error: "paths must lie inside the repository" }];
  return type === "git_stage"
    ? action(root, top, "stage", ["add", "--", ...paths])
    : action(root, top, "unstage", ["restore", "--staged", "--", ...paths]);
}
