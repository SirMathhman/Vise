import type { ResultMessage } from "./server-message.ts";
import type { Panels } from "./settings/panels.ts";

/** What the results update. */
interface ResultDeps {
  transcript: { addLine(cls: string, text: string): void; clear(): void };
  panels: Panels;
  profileSelect: HTMLSelectElement;
  reasoningSelect: HTMLSelectElement;
  setBurstPressed(on: boolean): void;
  setActiveModel(id: string): void;
  /** Ask the browser view for its tabs again (a saved session may have changed them). */
  syncBrowser(): void;
  requestToolRefresh(): void;
  refreshSessions(): void;
}

/** What a command the page sent did: update the header, the menus and the log. */
export function applyCommandResult(message: ResultMessage, deps: ResultDeps): void {
  const { transcript, panels, profileSelect, reasoningSelect, syncBrowser, requestToolRefresh, refreshSessions } = deps;
  const value = message.value ?? "";
  const prefixed = (prefix: string): string | undefined =>
    value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
  if (value === "started a new conversation" || value.startsWith("resumed session ")) {
    transcript.clear();
    transcript.addLine("system", value);
  } else if (value.startsWith("saved session ") || value.startsWith("deleted session ")) {
    transcript.addLine("system", value);
    if (value.startsWith("saved")) syncBrowser();
    refreshSessions();
  } else if (value.startsWith("burst mode ")) {
    const on = value.endsWith(" on");
    deps.setBurstPressed(on);
    transcript.addLine("system", `Burst mode ${on ? "on" : "off"}`);
  } else if (prefixed("switched to model ") !== undefined) {
    const model = prefixed("switched to model ") ?? "";
    deps.setActiveModel(model);
    transcript.addLine("system", `Model: ${model}`);
  } else if (prefixed("profile set to ") !== undefined) {
    const name = prefixed("profile set to ") ?? "";
    panels.removeProfilePlaceholder();
    profileSelect.value = name;
    transcript.addLine("system", `Profile: ${name}`);
    requestToolRefresh();
  } else if (prefixed("reasoning effort set to ") !== undefined) {
    const level = (prefixed("reasoning effort set to ") ?? "").replace(" (template default)", "");
    if ([...reasoningSelect.options].some((o) => o.value === level)) reasoningSelect.value = level;
    transcript.addLine("system", `Reasoning: ${level}`);
  } else if (value === "profile cleared") {
    panels.addProfilePlaceholder();
    profileSelect.value = "";
    transcript.addLine("system", "Profile cleared");
    requestToolRefresh();
  } else if (!message.streamed && value) {
    transcript.addLine("assistant", value);
  }
  if (message.compactionWarning) transcript.addLine("system", message.compactionWarning);
}

