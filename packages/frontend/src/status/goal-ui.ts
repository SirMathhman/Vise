/** The slice of a server message the goal UI reacts to. */
interface GoalMessage {
  type: string;
  id?: string;
  ok?: boolean;
  error?: string;
  /** `goal_state`: whether goal checking is on. */
  enabled?: boolean;
  /** `goal`: the line to show and how it should look. */
  text?: string;
  level?: string;
}

/** Id the `/goal` toggle line carries, so its reply is told apart from the model's turns. */
const TOGGLE_ID = "goal-toggle";

/** A verdict's one-line title and the evidence behind it: "✓ goal met — detail" splits at the first dash. */
export function splitVerdict(text: string): { title: string; detail: string } {
  const at = text.indexOf(" — ");
  if (at < 0) return { title: text, detail: "" };
  return { title: text.slice(0, at), detail: text.slice(at + 3) };
}

/**
 * Goal checking in the page: the Agent menu's toggle (`/goal on|off`), and the
 * goal and each verdict as lines in the chat (a met goal, a nudge back to work,
 * or a request for the user). The server owns the setting and tells the page
 * its state, so the menu always shows what is in effect.
 */
export function createGoalUi(
  addLine: (cls: string, text: string) => void,
  addCollapsed: (cls: string, title: string, detail: string) => void,
  send: (msg: Record<string, unknown>) => void,
): { handle(message: GoalMessage): boolean; isOn(): boolean; toggle(): void } {
  let enabled = false;
  return {
    isOn: () => enabled,
    toggle() {
      send({ type: "line", text: `/goal ${enabled ? "off" : "on"}`, id: TOGGLE_ID });
    },
    handle(message) {
      if (message.type === "goal_state") {
        enabled = message.enabled === true;
        return true;
      }
      if (message.type === "goal") {
        const cls = `system goal-${message.level ?? "info"}`;
        // A met goal is good news with its evidence folded away; anything else needs reading.
        const { title, detail } = splitVerdict(message.text ?? "");
        if (message.level === "ok" && detail) addCollapsed(cls, title, detail);
        else addLine(cls, message.text ?? "");
        return true;
      }
      if (message.type === "result" && message.id === TOGGLE_ID) {
        if (!message.ok) addLine("system goal-warn", message.error ?? "goal toggle failed");
        return true;
      }
      return false;
    },
  };
}
