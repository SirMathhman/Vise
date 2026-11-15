import type { ThinkingSettingEvent } from "../../../protocol/protocol.ts";

// The thinking control in the header: a menu of off, low, medium, and high, beside the model selector. Choosing a
// level sends /thinking, as typing it would, so the page keeps to lines.

export type ThinkingChoice = ThinkingSettingEvent["effort"];

export interface ThinkingActions {
  chooseThinking(level: ThinkingChoice): void;
}

export interface ThinkingControl {
  element: HTMLElement;
  update(current: ThinkingChoice | undefined, enabled: boolean): void;
}

const LEVELS: ThinkingChoice[] = ["off", "low", "medium", "high"];

export function createThinkingControl(doc: Document, actions: ThinkingActions): ThinkingControl {
  const element = doc.createElement("label");
  element.className = "thinking-control";
  element.append("thinking ");
  const select = doc.createElement("select");
  select.setAttribute("aria-label", "Thinking");
  for (const level of LEVELS) {
    const option = doc.createElement("option");
    option.value = level;
    option.textContent = level;
    select.append(option);
  }
  select.addEventListener("change", () => {
    const chosen = LEVELS.find((level) => level === select.value);
    if (chosen !== undefined) actions.chooseThinking(chosen);
  });
  element.append(select);
  return {
    element,
    update(current, enabled) {
      const shown = controlShown(current, enabled);
      select.disabled = shown.disabled;
      select.value = shown.value;
    },
  };
}

export interface ControlShown {
  disabled: boolean;
  value: string;
}

// What the control shows. Until the first thinkingSetting event the level is unknown, so the control stays blank
// and disabled rather than showing "off" for a session that may think at the default.
export function controlShown(current: ThinkingChoice | undefined, enabled: boolean): ControlShown {
  return { disabled: !enabled || current === undefined, value: current ?? "" };
}
