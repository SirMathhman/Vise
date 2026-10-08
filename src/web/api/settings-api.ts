import { describeSettings, saveSettings } from "../../settings/settings-file.ts";

/**
 * The settings page's messages (`env_get`, `env_set`), answered at once and
 * never queued behind a turn. Saved values apply live. Returns the replies, or
 * undefined when the message is not one of these.
 */
export function handleSettingsMessage(
  msg: Record<string, unknown>,
): Record<string, unknown>[] | undefined {
  if (msg.type === "env_get") {
    return [{ type: "env", ...describeSettings() }];
  }
  if (msg.type !== "env_set") return undefined;
  const sent = msg.values;
  const values: Record<string, string> = {};
  if (typeof sent === "object" && sent !== null) {
    for (const [name, value] of Object.entries(sent)) {
      if (typeof value === "string") values[name] = value;
    }
  }
  const clear = Array.isArray(msg.clear)
    ? msg.clear.filter((n): n is string => typeof n === "string")
    : [];
  const error = saveSettings(values, undefined, clear);
  return [
    {
      type: "env",
      ...describeSettings(),
      ...(error ? { error } : { saved: true }),
    },
  ];
}
