import { fetchModelDetails } from "../../client/model-queries.ts";
import { providerOf } from "../../client/provider.ts";
import { config } from "../../config.ts";
import { formatError } from "../../output/format.ts";
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

/**
 * `env_choices { source }`: suggestions for a setting that is a combobox.
 *   server → browser: { type:"env_choices", source, offers:[{ value, label }] }
 *                     { type:"env_choices", source, offers:[], error }
 * `local-models`: what the local llama.cpp server lists, embedding models first
 * (the router marks them with `--embedding`); any other text is still accepted.
 */
export async function handleEnvChoices(msg: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const source = typeof msg.source === "string" ? msg.source : "";
  if (source !== "local-models") return [{ type: "env_choices", source, offers: [], error: "unknown source" }];
  const listed = await fetchModelDetails(providerOf(config, "local"));
  if (!listed.ok) {
    return [{ type: "env_choices", source, offers: [], error: formatError(listed.error).replace(/^vise: /, "") }];
  }
  const offers = [...listed.value]
    .sort((a, b) => Number(b.embedding) - Number(a.embedding) || a.id.localeCompare(b.id))
    .map((m) => ({ value: m.id, label: m.embedding ? `${m.id} (embedding model)` : m.id }));
  return [{ type: "env_choices", source, offers }];
}
