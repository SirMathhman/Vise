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

/**
 * Goal checking in the page: a header toggle (`/goal on|off`), and the goal and
 * each verdict as lines in the chat (a met goal, a nudge back to work, or a
 * request for the user). The server owns the setting and tells the page its
 * state, so the button always shows what is in effect.
 */
export function createGoalUi(
  addLine: (cls: string, text: string) => void,
  send: (msg: Record<string, unknown>) => void,
): { handle(message: GoalMessage): boolean } {
  const button = document.getElementById("goal-btn") as HTMLButtonElement;
  button.addEventListener("click", () => {
    const on = button.getAttribute("aria-pressed") !== "true";
    send({ type: "line", text: `/goal ${on ? "on" : "off"}`, id: TOGGLE_ID });
  });
  return {
    handle(message) {
      if (message.type === "goal_state") {
        button.setAttribute("aria-pressed", String(message.enabled === true));
        return true;
      }
      if (message.type === "goal") {
        addLine(`system goal-${message.level ?? "info"}`, message.text ?? "");
        return true;
      }
      if (message.type === "result" && message.id === TOGGLE_ID) {
        if (!message.ok)
          addLine("system goal-warn", message.error ?? "goal toggle failed");
        return true;
      }
      return false;
    },
  };
}
