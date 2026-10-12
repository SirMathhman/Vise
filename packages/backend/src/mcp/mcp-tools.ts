import type { Tool } from "@vise/core";
import type { ImageOutbox } from "../tools/images.ts";
import type { McpCallResult, McpToolInfo } from "./mcp-connection.ts";

const MAX_NAME = 64;

const clean = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** A unique Vise tool name `mcp__<server>__<tool>` (at most 64 characters), adding a numeric suffix on a clash. */
export function toolName(
  server: string,
  tool: string,
  taken: Set<string>,
): string {
  const base = `mcp__${clean(server)}__${clean(tool)}`.slice(0, MAX_NAME);
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    const suffix = `_${i}`;
    name = base.slice(0, MAX_NAME - suffix.length) + suffix;
  }
  taken.add(name);
  return name;
}

/** The Vise tool definition for one MCP tool (deferred, in the category `mcp_<server>`). */
export function toVisTool(
  server: string,
  name: string,
  info: McpToolInfo,
): Tool {
  const description = info.description?.trim() || info.title || info.name;
  return {
    type: "function",
    display: { label: info.title ?? info.name, icon: "🔌" },
    deferred: true,
    category: `mcp_${clean(server)}`,
    function: {
      name,
      description: `[MCP ${server}] ${description}`,
      parameters: info.inputSchema,
    },
  };
}

/** Turn a tool result into text the model reads; pictures go to the outbox. A failed call starts with `error:`. */
export function formatResult(
  result: McpCallResult,
  images: ImageOutbox | undefined,
): string {
  const parts: string[] = [];
  for (const part of result.content ?? []) {
    const type = part["type"];
    if (type === "text" && typeof part["text"] === "string") {
      parts.push(part["text"]);
    } else if (type === "image" && typeof part["data"] === "string") {
      try {
        const bytes = Buffer.from(part["data"], "base64");
        const picture = images?.add(bytes, "mcp image");
        parts.push(picture ? `[image: ${picture.label}]` : "[image omitted]");
      } catch {
        parts.push("[image omitted: not a supported picture]");
      }
    } else if (type === "resource") {
      const res = part["resource"] as Record<string, unknown> | undefined;
      parts.push(
        typeof res?.["text"] === "string"
          ? res["text"]
          : `[resource ${String(res?.["uri"] ?? "")}]`,
      );
    } else if (type === "resource_link") {
      parts.push(`[resource ${String(part["uri"] ?? "")}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  const text = parts.join("\n") || "(no output)";
  return result.isError ? `error: ${text}` : text;
}
