import type { LlmToolResult } from "../../llmToolTypes.js";
import type { PageActionName } from "../actions.js";
import type { BrowserSession } from "../session.js";
import type { FirefoxBridge } from "./bridge.js";

/**
 * The Firefox-backed implementation of the model-facing browser tools: each
 * one is sent to the extension, which performs it in the user's own Firefox
 * (see apps/firefox-extension) and answers with the same kind of model-readable
 * text the Chrome session produces, so the model can't tell which it is
 * driving. Only the tool-facing half of a BrowserSession exists here; the
 * viewer-panel half (screencast, panel input) belongs to the Chrome session.
 */
export type FirefoxSession = Pick<
  BrowserSession,
  "open" | "snapshot" | "act" | "screenshot" | "dialog"
>;

/** A tool result as plain text (a text-only tool never returns images). */
function asText(r: string | LlmToolResult): string {
  return typeof r === "string" ? r : r.text;
}

export function createFirefoxSession(bridge: FirefoxBridge): FirefoxSession {
  return {
    async open(args) {
      return asText(await bridge.call("browser_open", args));
    },
    async snapshot() {
      return asText(await bridge.call("browser_snapshot", {}));
    },
    async act(tool: PageActionName, args) {
      return asText(await bridge.call(tool, args));
    },
    screenshot(args) {
      return bridge.call("browser_screenshot", args);
    },
    async dialog(args) {
      return asText(await bridge.call("browser_dialog", args));
    },
  };
}
