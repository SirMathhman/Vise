import type { ResultMessage } from "./server-message.ts";

/** What the results update. */
interface ResultDeps {
  transcript: { addLine(cls: string, text: string): void; clear(): void };
  setActiveModel(id: string): void;
  /** Ask the browser view for its tabs again (a saved session may have changed them). */
  syncBrowser(): void;
}

/**
 * What a command the page sent did to the log. The header, tools panel and menus
 * follow the server's `lists` (sent after every line), not this text; only the
 * log lines and the model picker are driven from the result.
 */
export function applyCommandResult(message: ResultMessage, deps: ResultDeps): void {
  const { transcript, syncBrowser } = deps;
  const value = message.value ?? "";
  const prefixed = (prefix: string): string | undefined =>
    value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
  if (value === "started a new conversation" || value.startsWith("resumed session ")) {
    transcript.clear();
    transcript.addLine("system", value);
  } else if (value.startsWith("saved session ") || value.startsWith("deleted session ")) {
    transcript.addLine("system", value);
    if (value.startsWith("saved")) syncBrowser();
  } else if (value.startsWith("burst mode ")) {
    transcript.addLine("system", `Burst mode ${value.endsWith(" on") ? "on" : "off"}`);
  } else if (prefixed("switched to model ") !== undefined) {
    const model = prefixed("switched to model ") ?? "";
    deps.setActiveModel(model);
    transcript.addLine("system", `Model: ${model}`);
  } else if (prefixed("profile set to ") !== undefined) {
    transcript.addLine("system", `Profile: ${prefixed("profile set to ")}`);
  } else if (prefixed("reasoning effort set to ") !== undefined) {
    const level = (prefixed("reasoning effort set to ") ?? "").replace(" (template default)", "");
    transcript.addLine("system", `Reasoning: ${level}`);
  } else if (value === "profile cleared") {
    transcript.addLine("system", "Profile cleared");
  } else if (!message.streamed && value) {
    transcript.addLine("assistant", value);
  }
  if (message.compactionWarning) transcript.addLine("system", message.compactionWarning);
}
