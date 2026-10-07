/** The server's `browser_settings` message: the engine the shared browser uses. */
export interface BrowserSettingsFields {
  engine?: string;
  firefoxPort?: number;
  firefoxFound?: boolean;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "setting-row";
  const text = document.createElement("span");
  text.textContent = label;
  row.append(text, control);
  return row;
}

/**
 * The "browser" settings tab: which engine the integrated browser uses
 * (Chromium or Firefox) and, for Firefox, an optional port to attach to a
 * Firefox the user started with `--remote-debugging-port` instead of launching
 * one. The setting is global: the server applies it to every session and tells
 * every open page, so the form always shows what is actually in effect.
 */
export function createBrowserSettings(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
): { handle(message: BrowserSettingsFields): void } {
  const engine = document.createElement("select");
  engine.className = "model";
  engine.append(new Option("Chromium (Edge or Chrome)", "chromium"));
  engine.append(new Option("Firefox", "firefox"));

  const port = document.createElement("input");
  port.className = "save-input";
  port.type = "number";
  port.min = "1";
  port.max = "65535";
  port.placeholder = "launch Vise's own Firefox";

  const hint = document.createElement("div");
  hint.className = "setting-hint";
  hint.textContent =
    "Firefox: leave the port empty to launch a private headless Firefox. To use a Firefox you already run, start it with --remote-debugging-port=9222 and enter that port; Firefox allows one attached client at a time. browser_run_code is not available with Firefox.";

  const status = document.createElement("div");
  status.className = "pe-status";
  status.setAttribute("role", "status");

  const save = document.createElement("button");
  save.className = "save-btn";
  save.textContent = "save";
  save.addEventListener("click", () => {
    status.textContent = "switching… open browser tabs will close";
    send({
      type: "browser_settings_set",
      engine: engine.value,
      firefoxPort: engine.value === "firefox" ? port.value : "",
    });
  });

  const firefoxOnly = [port, hint];
  const sync = (): void => {
    for (const item of firefoxOnly) {
      item.classList.toggle("hidden", engine.value !== "firefox");
    }
  };
  engine.addEventListener("change", sync);
  body.append(field("engine", engine), field("attach to port", port), hint);
  const row = document.createElement("div");
  row.className = "save-row";
  row.append(save, status);
  body.append(row);
  sync();

  return {
    handle(message) {
      engine.value = message.engine === "firefox" ? "firefox" : "chromium";
      port.value = message.firefoxPort ? String(message.firefoxPort) : "";
      sync();
      const missing =
        message.firefoxFound === false && !message.firefoxPort
          ? " (Firefox is not installed at its usual location)"
          : "";
      status.textContent =
        message.engine === "firefox"
          ? `using Firefox${missing}`
          : "using Chromium";
    },
  };
}
