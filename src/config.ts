// Typed, env-derived settings. Read-only everywhere except the model
// selector, which owns the mutable `model` field. No I/O beyond reading
// env, no fetch.
export type Config = {
  baseUrl: string;
  model: string;
  embedModel: string;
  apiKey?: string;
  preSessionCmd?: string;
  preTurnCmd?: string;
  postTurnCmd?: string;
  preSessionCmdProfiles?: string[];
  preTurnCmdProfiles?: string[];
  postTurnCmdProfiles?: string[];
};

function parseProfiles(env: string | undefined): string[] | undefined {
  if (!env) return undefined;
  const list = env
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return list.length > 0 ? list : undefined;
}

export function loadConfig(): Config {
  return {
    baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:8080",
    model: process.env.LLM_MODEL ?? "local",
    embedModel: process.env.LLM_EMBED_MODEL ?? "embed",
    apiKey: process.env.LLM_API_KEY,
    preSessionCmd: process.env.PRE_SESSION_CMD,
    preTurnCmd: process.env.PRE_TURN_CMD,
    postTurnCmd: process.env.POST_TURN_CMD,
    preSessionCmdProfiles: parseProfiles(process.env.PRE_SESSION_CMD_PROFILES),
    preTurnCmdProfiles: parseProfiles(process.env.PRE_TURN_CMD_PROFILES),
    postTurnCmdProfiles: parseProfiles(process.env.POST_TURN_CMD_PROFILES),
  };
}
