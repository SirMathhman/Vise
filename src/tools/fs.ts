// File-system tool handlers: read_file, edit_file, create_file,
// create_directory, list_directory.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

export const read_file = async (
  args: Record<string, unknown>,
): Promise<string> => {
  const rawPath = String(args.path ?? "");
  const filePath = path.resolve(process.cwd(), rawPath);
  const startLine = Math.max(1, Number(args.startLine ?? 1));
  const endLine = Math.max(startLine, Number(args.endLine ?? Infinity));
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const total = lines.length;
    const cappedEnd = Math.min(endLine, startLine + 499);
    const slice = lines.slice(startLine - 1, cappedEnd);
    const prefix =
      startLine > 1 || cappedEnd < total
        ? `Lines ${startLine}–${cappedEnd} of ${total}:\n\n`
        : "";
    return prefix + slice.join("\n");
  } catch (err) {
    return `Error reading ${rawPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
};

export const edit_file = async (
  args: Record<string, unknown>,
): Promise<string> => {
  const rawPath = String(args.path ?? "");
  const filePath = path.resolve(process.cwd(), rawPath);
  const replacee = String(args.replacee ?? "");
  const replacement = String(args.replacement ?? "");
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf-8");
  } catch (err) {
    return `Error reading ${rawPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  const index = contents.indexOf(replacee);
  if (index < 0) {
    if (replacee.length === 0) {
      return `No change: replacee is empty, so ${rawPath} is unchanged.`;
    }
    return `No change: replacee was not found in ${rawPath}. Read the file and retry with the exact text.`;
  }
  const updated =
    contents.slice(0, index) +
    replacement +
    contents.slice(index + replacee.length);
  try {
    writeFileSync(filePath, updated, "utf-8");
  } catch (err) {
    return `Error writing ${rawPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return `Edited ${rawPath}: replaced ${replacee.length} character(s) starting at offset ${index}.`;
};

export const create_file = async (
  args: Record<string, unknown>,
): Promise<string> => {
  const rawPath = String(args.path ?? "");
  const filePath = path.resolve(process.cwd(), rawPath);
  const content = String(args.content ?? "");
  if (existsSync(filePath)) {
    return `Error creating ${rawPath}: file already exists.`;
  }
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf-8");
  } catch (err) {
    return `Error creating ${rawPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return `Created ${rawPath} (${content.length} character(s)).`;
};

export const create_directory = async (
  args: Record<string, unknown>,
): Promise<string> => {
  const rawPath = String(args.path ?? "");
  const filePath = path.resolve(process.cwd(), rawPath);
  if (existsSync(filePath)) {
    return `Error creating ${rawPath}: directory already exists.`;
  }
  try {
    mkdirSync(filePath, { recursive: true });
  } catch (err) {
    return `Error creating ${rawPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return `Created directory ${rawPath}.`;
};

export const list_directory = async (
  args: Record<string, unknown>,
): Promise<string> => {
  const rawPath = String(args.path ?? ".");
  const dirPath = path.resolve(process.cwd(), rawPath);
  const depth = Math.max(1, Math.min(5, Number(args.depth ?? 1)));
  if (!existsSync(dirPath)) {
    return `Error listing ${rawPath}: path does not exist.`;
  }
  const stat = statSync(dirPath);
  if (!stat.isDirectory()) {
    return `Error listing ${rawPath}: not a directory.`;
  }
  const lines: string[] = [];
  const walk = (dir: string, indent: number, remaining: number) => {
    const entries = readdirSync(dir);
    for (const name of entries) {
      const fullPath = path.join(dir, name);
      const isDir = statSync(fullPath).isDirectory();
      lines.push(`${"  ".repeat(indent)}${name}${isDir ? "/" : ""}`);
      if (isDir && remaining > 1) {
        walk(fullPath, indent + 1, remaining - 1);
      }
    }
  };
  walk(dirPath, 0, depth);
  return lines.length > 0 ? lines.join("\n") : "(empty directory)";
};
