/**
 * A tool the LLM can run against the workspace. The model calls these through
 * POST /api/llm/tool; each tool maps a name and JSON arguments to a text
 * result the model can read back. Every tool reaches the filesystem only via
 * the sandboxed resolvers in fs.ts, so path safety is centralized there.
 *
 * Shared by the four llm* route modules (llm.ts's registry, llmCommand.ts,
 * llmFs.ts, llmSearch.ts) so none of them has to import another's internals
 * just to name this type — a type-only module, erased at compile time.
 */
export type LlmToolHandler = (
  args: Record<string, unknown>,
  root: string
) => Promise<string | LlmToolResult>;

/**
 * A tool result that carries images alongside its text (browser_screenshot).
 * `images` are data URLs. Tools with no images just return a string.
 */
export interface LlmToolResult {
  text: string;
  images: string[];
}
