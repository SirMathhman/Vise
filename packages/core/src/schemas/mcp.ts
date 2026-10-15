import { z } from "zod";

/** A server started as a local process and spoken to over stdio. */
export interface StdioServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A server reached at an http(s) URL (Streamable HTTP, or the older SSE transport). */
export interface UrlServerSpec {
  url: string;
  headers: Record<string, string>;
}

/** Discriminated union of the two server kinds, keyed by which field is present. */
export type McpServerSpec = StdioServerSpec | UrlServerSpec;

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

export const stdioServerSpecSchema: z.ZodType<StdioServerSpec> = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
}) as z.ZodType<StdioServerSpec>;

export const urlServerSpecSchema: z.ZodType<UrlServerSpec> = z.object({
  url: z.string().refine(isHttpUrl, {
    message: "'url' must be an http or https address",
  }),
  headers: z.record(z.string(), z.string()).default({}),
}) as z.ZodType<UrlServerSpec>;

export const mcpServerSpecSchema: z.ZodType<McpServerSpec> = z.union([
  stdioServerSpecSchema,
  urlServerSpecSchema,
]) as z.ZodType<McpServerSpec>;

export const mcpFileSchema: z.ZodType<{
  mcpServers: Record<string, McpServerSpec>;
}> = z.object({
  mcpServers: z.record(z.string(), mcpServerSpecSchema),
}) as z.ZodType<{ mcpServers: Record<string, McpServerSpec> }>;
