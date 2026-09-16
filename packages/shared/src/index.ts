/**
 * The single source of truth for the LLM tool names. The frontend defines its
 * tools against this union (see LlmTool in api/client) and the backend keys
 * its handler table with it (see routes/llm), so a renamed or misspelled name
 * on either side is a compile error rather than a silent no-op.
 */
export const LLM_TOOL_NAMES = [
  "list_directory",
  "find_files",
  "read_file",
  "edit_file",
  "create_directory",
  "create_file",
  "delete_file",
  "delete_directory",
  "run_command",
] as const;

/** The set of tool names the model may call. */
export type LlmToolName = (typeof LLM_TOOL_NAMES)[number];
