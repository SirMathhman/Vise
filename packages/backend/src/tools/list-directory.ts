import { parseJson } from "common";
import { z } from "zod";
import { projectFiles, resolveInside } from "../project/project-files";

// The path check is shared with the file reader; it stays importable from here.
export { resolveInside } from "../project/project-files";

/**
 * The name the model uses to call the list-directory tool.
 */
export const LIST_DIRECTORY_NAME = "list_directory";

/**
 * The tool the model may call. It only lists; it never reads file contents.
 */
export const LIST_DIRECTORY_TOOL = {
  type: "function" as const,
  function: {
    name: LIST_DIRECTORY_NAME,
    description:
      "List the subdirectories and files under a directory of the project, recursively. Paths are relative to the project root. Files that git ignores are not listed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Directory relative to the project root. Use "." for the root.',
        },
        max_depth: {
          type: "integer",
          description:
            "How many levels to descend, from 1 to 5. Defaults to 2.",
        },
        max_entries: {
          type: "integer",
          description:
            "The most entries to return, from 1 to 500. Defaults to 100.",
        },
      },
      required: ["path"],
    },
  },
};

const ListArgumentsSchema = z.object({
  path: z.string(),
  max_depth: z.number().int().min(1).max(5).default(2),
  max_entries: z.number().int().min(1).max(500).default(100),
});

// A directory tree: a directory maps names to subtrees, and a file maps to null.
type Tree = Map<string, Tree | null>;

/**
 * Builds a directory tree from relative file paths. A directory maps its names to subtrees; a file maps to null.
 */
export function buildTree(files: string[]): Tree {
  const root: Tree = new Map();
  for (const file of files) {
    const parts = file.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const existing = node.get(part);
      if (existing) {
        node = existing;
      } else {
        const created: Tree = new Map();
        node.set(part, created);
        node = created;
      }
    }
    node.set(parts[parts.length - 1], null);
  }
  return root;
}

/**
 * Renders the directory at target as indented lines, directories first, cut to maxEntries.
 */
export function renderListing(
  files: string[],
  target: string,
  maxDepth: number,
  maxEntries: number,
): string {
  let node: Tree | null | undefined = buildTree(files);
  for (const part of target === "" ? [] : target.split("/")) {
    node = node?.get(part);
  }
  if (node === undefined) {
    return `No directory named "${target}" in the project.`;
  }
  if (node === null) {
    return `"${target}" is a file, not a directory.`;
  }

  const lines: string[] = [];
  const collect = (dir: Tree, depth: number, indent: string): void => {
    const names = [...dir.keys()].sort((a, b) => {
      const aFile = dir.get(a) === null;
      const bFile = dir.get(b) === null;
      return aFile === bFile ? a.localeCompare(b) : aFile ? 1 : -1;
    });
    for (const name of names) {
      const child = dir.get(name);
      if (child === null || child === undefined) {
        lines.push(`${indent}${name}`);
      } else {
        lines.push(`${indent}${name}/`);
        if (depth < maxDepth) {
          collect(child, depth + 1, `${indent}  `);
        }
      }
    }
  };
  collect(node, 1, "");

  if (lines.length === 0) {
    return "The directory has no files that git does not ignore.";
  }
  const shown = lines.slice(0, maxEntries);
  const hidden = lines.length - shown.length;
  return hidden > 0
    ? `${shown.join("\n")}\n... ${String(hidden)} more entries not shown`
    : shown.join("\n");
}

/**
 * Runs the tool for the model's arguments and returns the text the model reads back.
 */
export async function runListDirectory(
  root: string,
  argumentsJson: string,
): Promise<string> {
  const args = parseJson(ListArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return "The arguments were not valid. Use path, and optionally max_depth and max_entries.";
  }
  const target = resolveInside(root, args.value.path);
  if (!target.ok) {
    return target.error;
  }
  const files = await projectFiles(root);
  if (!files.ok) {
    return files.error;
  }
  return renderListing(
    files.value,
    target.value,
    args.value.max_depth,
    args.value.max_entries,
  );
}
