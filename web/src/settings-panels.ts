import {
  type BrowserSettingsFields,
  createBrowserSettings,
} from "./browser-settings.ts";
import { createEnvPanel, type EnvMessage } from "./env-panel.ts";
import { createNotesPanel, type NotesMessage } from "./notes-panel.ts";

/** The slice of a server message the settings tabs react to. */
type SettingsMessage = NotesMessage & BrowserSettingsFields & EnvMessage;

function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

/**
 * The settings tabs that talk to the server directly (browser engine, notes).
 * The profiles and hooks tabs have their own modules because other parts of
 * the page depend on them.
 */
export function createSettingsPanels(
  send: (msg: Record<string, unknown>) => void,
): { handle(message: SettingsMessage): boolean } {
  const browser = createBrowserSettings(el("browser-settings-body"), send);
  const general = createEnvPanel(el("general-body"), send, [
    el("settings-btn"),
    el("general-tab"),
  ]);
  const notes = createNotesPanel(el("notes-body"), send, [
    el("settings-btn"),
    el("notes-tab"),
  ]);
  return {
    handle(message) {
      if (message.type === "browser_settings") {
        browser.handle(message);
        return true;
      }
      return general.handle(message) || notes.handle(message);
    },
  };
}
