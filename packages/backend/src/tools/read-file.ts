import { parseJson } from "common";
import { z } from "zod";
import { readProjectText } from "../project/project-files";

export const READ_FILE_NAME = "read_file";

// The tool the model may call. It reads text; it never writes.
export const READ_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: READ_FILE_NAME,
    description:
      "Read the text of a file in the project. Paths are relative to the project root. Files that git ignores cannot be read. Long files are cut; use start_line and end_line to read more.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the project root.",
        },
        start_line: {
          type: "integer",
          description: "First line to return, counting from 1. Defaults to 1.",
        },
        end_line: {
          type: "integer",
          description:
            "Last line to return, inclusive. Defaults to the end of the file.",
        },
      },
      required: ["path"],
    },
  },
};

// Longest text one call returns.
const MAX_CHARS = 20000;

const ReadArgumentsSchema = z.object({
  path: z.string(),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

// The lines start..end of a file's text, cut to MAX_CHARS. The header names the lines
// actually returned, so a cut read never looks complete.
export function readRange(
  text: string,
  start: number,
  end: number | undefined,
): string {
  const lines = text.split("\n");
  if (start > lines.length) {
    return `The file has ${String(lines.length)} lines; start_line ${String(start)} is past the end.`;
  }
  if (end !== undefined && end < start) {
    return "end_line must not be before start_line.";
  }
  const last = Math.min(end ?? lines.length, lines.length);
  let lastShown = start - 1;
  let size = 0;
  for (let n = start; n <= last; n += 1) {
    const line = lines[n - 1] ?? "";
    if (size + line.length > MAX_CHARS && lastShown >= start) {
      break;
    }
    size += line.length + 1;
    lastShown = n;
  }
  const joined = lines.slice(start - 1, lastShown).join("\n");
  const cut = lastShown < last || joined.length > MAX_CHARS;
  const body = cut
    ? `${joined.slice(0, MAX_CHARS)}\n... cut; read a smaller line range to see more`
    : joined;
  return `Lines ${String(start)}-${String(lastShown)} of ${String(lines.length)}:\n${body}`;
}

// Runs the tool for the model's arguments and returns the text the model reads back.
export async function runReadFile(
  root: string,
  argumentsJson: string,
): Promise<string> {
  const args = parseJson(ReadArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return "The arguments were not valid. Use path, and optionally start_line and end_line.";
  }
  const file = await readProjectText(root, args.value.path);
  if (!file.ok) {
    return file.error;
  }
  return readRange(
    file.value.text,
    args.value.start_line ?? 1,
    args.value.end_line,
  );
}
