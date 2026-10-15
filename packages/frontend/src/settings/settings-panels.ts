import { type BrowserSettingsFields, createBrowserSettings } from "./browser-settings.ts";
import { createEnvPanel, type EnvMessage } from "./env-panel.ts";
import { createMcpPanel, type McpMessage } from "./mcp/mcp-panel.ts";
import { createNotesPanel, type NotesMessage } from "./notes-panel.ts";
import { createWorkflowsPanel, type WorkflowsMessage } from "./workflows/workflows-panel.ts";
import { requiredElement as el } from "../dom.ts";

/** The slice of a server message the settings tabs react to. */
type SettingsMessage = NotesMessage &
  WorkflowsMessage &
  BrowserSettingsFields &
  McpMessage &
  EnvMessage;

/**
 * The settings tabs that talk to the server directly (browser engine, notes).
 * The profiles and hooks tabs have their own modules because other parts of
 * the page depend on them.
 */
export function createSettingsPanels(
  send: (msg: Record<string, unknown>) => void,
  /** Whether a turn is running (the MCP tab reloads the page only between turns). */
  isBusy: () => boolean,
): { handle(message: SettingsMessage): boolean } {
  const browser = createBrowserSettings(el("browser-settings-body"), send);
  const general = createEnvPanel(el("general-body"), send, [el("settings-btn"), el("general-tab")]);
  const mcp = createMcpPanel(el("mcp-body"), send, [el("settings-btn"), el("mcp-tab")], isBusy);
  const notes = createNotesPanel(el("notes-body"), send, [el("settings-btn"), el("notes-tab")]);
  const workflows = createWorkflowsPanel(el("workflows-body"), send, [
    el("settings-btn"),
    el("workflows-tab"),
  ]);
  return {
    handle(message) {
      if (message.type === "browser_settings") {
        browser.handle(message);
        return true;
      }
      return (
        general.handle(message) ||
        mcp.handle(message) ||
        notes.handle(message) ||
        workflows.handle(message)
      );
    },
  };
}
