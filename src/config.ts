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
  reasoningLevels: ReasoningLevel[];
};

// A named reasoning budget selectable with /think <name>. `tokens` is sent as
// the per-request reasoning_budget_tokens (uniform mode: thinking is cut off
// at a uniformly random length up to `tokens`, or ends sooner on its own).
export type ReasoningLevel = { name: string; tokens: number };

// Built-in levels, used when LLM_REASONING_LEVELS is unset.
const DEFAULT_REASONING_LEVELS: ReasoningLevel[] = [
  { name: "low", tokens: 512 },
  { name: "medium", tokens: 2048 },
  { name: "high", tokens: 8192 },
  { name: "max", tokens: 32768 },
];

// The level a fresh session starts on, when the table defines it; otherwise
// no level is sent and the server's own --reasoning-budget applies.
export const DEFAULT_REASONING_LEVEL = "medium";

// Parses LLM_REASONING_LEVELS ("name:tokens,name:tokens,..."; any names, in
// the order given). Throws on a malformed entry so a typo fails loudly at
// startup instead of silently dropping a level.
function parseReasoningLevels(env: string | undefined): ReasoningLevel[] {
  if (!env || env.trim().length === 0) return DEFAULT_REASONING_LEVELS;
  const levels: ReasoningLevel[] = [];
  for (const entry of env.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const match = /^([^:\s]+)\s*:\s*(\d+)$/.exec(trimmed);
    const name = match?.[1];
    const tokens = Number(match?.[2]);
    if (!name || !Number.isInteger(tokens) || tokens <= 0) {
      throw new Error(
        `LLM_REASONING_LEVELS: invalid entry "${trimmed}" (expected name:tokens, e.g. high:8192)`,
      );
    }
    if (levels.some((l) => l.name === name)) {
      throw new Error(`LLM_REASONING_LEVELS: duplicate level "${name}"`);
    }
    levels.push({ name, tokens });
  }
  if (levels.length === 0) {
    throw new Error("LLM_REASONING_LEVELS: no levels defined");
  }
  return levels;
}

function parseProfiles(env: string | undefined): string[] | undefined {
  if (!env) return undefined;
  const list = env
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return list.length > 0 ? list : undefined;
}

export function loadConfig(): Config {
  const model = process.env.LLM_MODEL ?? "local";
  return {
    baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:8080",
    model,
    embedModel: process.env.LLM_EMBED_MODEL ?? model,
    apiKey: process.env.LLM_API_KEY,
    preSessionCmd: process.env.PRE_SESSION_CMD,
    preTurnCmd: process.env.PRE_TURN_CMD,
    postTurnCmd: process.env.POST_TURN_CMD,
    preSessionCmdProfiles: parseProfiles(process.env.PRE_SESSION_CMD_PROFILES),
    preTurnCmdProfiles: parseProfiles(process.env.PRE_TURN_CMD_PROFILES),
    postTurnCmdProfiles: parseProfiles(process.env.POST_TURN_CMD_PROFILES),
    reasoningLevels: parseReasoningLevels(process.env.LLM_REASONING_LEVELS),
  };
}
