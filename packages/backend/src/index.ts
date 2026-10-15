// Barrel for @vise/backend. Re-exports everything the other packages need.
//
// NOTE: ./terminal-main.ts is a side-effect module that runs the REPL, and
// ./settings/settings-init.ts is a side-effect module — neither is re-exported
// here. Consumers import the CLI entrypoint and loadSettingsFile() directly.

export { config } from "./config.ts";
export { dataDirFor, noFolderRoot, globalDataDir } from "./data-dir.ts";
export { VERSION } from "./version.ts";
export { tools } from "./tools.ts";
export { createEdgeSession } from "./wiring.ts";
export type { EdgeSession, EdgeSessionOptions, ModelPickerPorts } from "./wiring.ts";
export { HookStore } from "./edge-sources.ts";
export { buildInitialTree } from "./fs-tree.ts";
export { GLOBAL_PROMPT } from "./prompt/global-prompt.ts";
export {
  REF_PATTERN,
  SNAPSHOT_SCRIPT,
  focusScript,
  probeScript,
  fileInputScript,
  fileInputProblem,
  pageActionScript,
} from "./browser/page-scripts.ts";
export type { PageAction } from "./browser/page-scripts.ts";
export type { TabInfo, BrowserInput, BrowserBackend, BackendCapabilities } from "./browser/types.ts";
export { BrowserSettingsStore } from "./browser/settings.ts";
export type { BrowserEngine, BrowserSettings } from "./browser/settings.ts";
export { ExtensionBackend, describeShare } from "./browser/extension.ts";
export type { ShareEvent, ExtensionLink } from "./browser/extension.ts";
export { SwitchableBrowser } from "./browser/switchable.ts";
export type { PageProbe } from "./browser/probe.ts";
export { LlmClient } from "./client/llm.ts";
export {
  fetchModelDetails,
  fetchHostedInfo,
  localSupportsVision,
  fetchSlotContext,
  fetchEmbeddings,
  looksLikeEmbedder,
} from "./client/model-queries.ts";
export type { ModelDetail } from "./client/model-queries.ts";
export {
  providerFor,
  providerOf,
  defaultProviderId,
  modelRef,
  parseModelRef,
  reasoningFields,
  responseFormat,
  modelInfo,
} from "./client/provider.ts";
export type {
  ProviderId,
  Provider,
  ProviderSettings,
  ProviderCapabilities,
  ModelInfo,
} from "./client/provider.ts";
export { openDb } from "./db/open.ts";
export { McpHub } from "./mcp/mcp-hub.ts";
export type { McpServerReport } from "./mcp/mcp-hub.ts";
export { handleMcpCommand } from "./mcp/mcp-command.ts";
export { mcpNote } from "./output/mcp-format.ts";
export { httpReason, formatError, formatContext, formatGoalEvent, formatCompactionFailure } from "./output/format.ts";
export { formatWorkflowEvent } from "./output/workflow-format.ts";
export { saveProfileWhitelist } from "./repl/profile-tools.ts";
export { switchModel } from "./repl/commands/commands.ts";
export { loadSession, latestSessionId } from "./stores/sessions.ts";
export { imageStore, sniffImage } from "./stores/image-store.ts";
export { readEntries, removeEntry, saveEntry } from "./mcp/mcp-store.ts";
export type { McpEntry, McpScope } from "./mcp/mcp-store.ts";
export { deleteWorkflowAt, listWorkflows, readWorkflowAt, saveWorkflowAt } from "./stores/workflows.ts";
export type { CallLog } from "./client/stream/call-trace.ts";
export { parseSettings } from "./browser/settings.ts";
export {
  formatToolCall,
  summarizeToolResult,
  toolLabel,
  clipDetail,
  formatPicture,
  toolDetail,
} from "./output/tool-line.ts";
export type { ToolDisplay, DisplayLookup } from "./output/tool-line.ts";
export { displayOfTool } from "./tools/display.ts";
export { askToContinue } from "./tools/agent/ask-user.ts";
export type { AskRequest, UserPrompter } from "./tools/agent/ask-user.ts";
export { Session } from "./repl/session.ts";
export type { LineResult, SessionOptions } from "./repl/session.ts";
export type { SemanticIndexPort } from "./repl/ports.ts";
export { collectLists } from "./repl/lists.ts";
export {
  settingsPath,
  parseEnv,
  loadSettingsFile,
  saveSettings,
  describeSettings,
} from "./settings/settings-file.ts";
export { NoteStore, requireScope } from "./stores/note-store.ts";
export type { NoteId } from "./stores/note-store.ts";
export { categoryOf, scopeOf, listNotes, readNote, saveNote, deleteNote } from "./stores/notes.ts";
export type { NoteScope, NoteStores, NoteEntry, NoteRef } from "./stores/notes.ts";
export {
  listProfiles,
  readProfile,
  saveProfile,
  deleteProfile,
  renameProfile,
  writeProfileBody,
  readProfileTools,
  setProfileTools,
  readAllProfileHooks,
  setProfileHooks,
} from "./stores/profiles.ts";
export type { ParsedProfile } from "@vise/core";
export { missingBuildOutput } from "./build/build-check.ts";
export { runMaintenance, extensionDir } from "./build/maintenance.ts";
