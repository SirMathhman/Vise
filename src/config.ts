/**
 * Settings, resolved live. A setting's value is the one in the user's settings
 * file (`~/.vise/.env`, loaded and saved by `settings-file.ts`), else the
 * process environment, else its default. A value that is not a number or is
 * below its minimum falls back to the default, so a bad file never stops Vise
 * starting. `applySettings` swaps in new file values and every later read of
 * `config.x` sees them, which is why code reads `config.x` where it uses a
 * value instead of keeping a copy; the few `restart` settings are used once at
 * start-up. Edge code only (the pure core takes values as parameters). Also
 * bundled into the Firefox extension, where there is no `process` or file, so
 * the defaults apply.
 */
export interface Spec {
  /** The variable name in the file and the environment. */
  env: string;
  def: string | number;
  /** Smallest accepted number. */
  min?: number;
  group: string;
  label: string;
  /** Never shown back to the page. */
  secret?: boolean;
  /** Used once at start-up: a change applies after a restart. */
  restart?: boolean;
}

const n = (
  env: string,
  def: number,
  group: string,
  label: string,
  more: Partial<Spec> = {},
): Spec => ({ env, def, min: 1, group, label, ...more });

const LLM = "LLM server";
const COMPACT = "Context & long turns";
const GOAL = "Goal checking";
const TOOLS = "Tool output & files";
const BROWSER = "Browser tools";
const TERMINAL = "Integrated terminal";
const MCP = "MCP servers";

export const SPEC = {
  llmBaseUrl: {
    env: "VISE_LLM_URL",
    def: "http://localhost:8080",
    group: LLM,
    label: "server address",
  },
  llmApiKey: {
    env: "VISE_LLM_API_KEY",
    def: "",
    group: LLM,
    label: "API key",
    secret: true,
  },
  llmModel: {
    env: "VISE_LLM_MODEL",
    def: "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:QATFA",
    group: LLM,
    label: "default model",
  },
  embeddingModel: {
    env: "VISE_EMBEDDING_MODEL",
    def: "",
    group: LLM,
    label: "embedding model for semantic search (a model on the local server that can embed; empty = the default local model)",
  },
  semanticAutoIndex: n(
    "VISE_SEMANTIC_AUTOINDEX",
    1,
    LLM,
    "index a folder's files for semantic search in the background when it opens (1 = on, 0 = only on /embed)",
    { min: 0 },
  ),
  llmRetries: n(
    "VISE_LLM_RETRIES",
    2,
    LLM,
    "ask again after a busy or rate-limited reply (HTTP 408, 429, 502, 503, 504; 0 = never)",
    { min: 0 },
  ),
  llmProvider: {
    env: "VISE_LLM_PROVIDER",
    def: "local",
    group: LLM,
    label: "provider (local or openrouter)",
  },
  openrouterUrl: {
    env: "VISE_OPENROUTER_URL",
    def: "https://openrouter.ai/api/v1",
    group: LLM,
    label: "OpenRouter address",
  },
  openrouterApiKey: {
    env: "VISE_OPENROUTER_API_KEY",
    def: "",
    group: LLM,
    label: "OpenRouter API key",
    secret: true,
  },
  openrouterModel: {
    env: "VISE_OPENROUTER_MODEL",
    def: "anthropic/claude-sonnet-4.5",
    group: LLM,
    label: "OpenRouter default model",
  },
  slotRequestTimeoutMs: n(
    "VISE_SLOT_REQUEST_TIMEOUT_MS",
    5_000,
    LLM,
    "slot lookup timeout for helper agents (ms)",
  ),
  port: n("PORT", 3000, "Web server", "port", { restart: true }),
  recentTurnsToKeep: n(
    "VISE_RECENT_TURNS_TO_KEEP",
    2,
    COMPACT,
    "turns kept when compacting",
  ),
  roundsToKeep: n(
    "VISE_ROUNDS_TO_KEEP",
    10,
    COMPACT,
    "rounds kept when compacting inside a turn",
  ),
  tailShare: n(
    "VISE_TAIL_SHARE",
    0.25,
    COMPACT,
    "share of the window kept verbatim",
    { min: 0.05 },
  ),
  inTurnCompactionThreshold: n(
    "VISE_IN_TURN_COMPACTION_THRESHOLD",
    0.75,
    COMPACT,
    "compact inside a turn at (fraction full)",
    { min: 0.1 },
  ),
  compactionThreshold: n(
    "VISE_COMPACTION_THRESHOLD",
    0.9,
    COMPACT,
    "compact between turns at (fraction full)",
    { min: 0.1 },
  ),
  auditEnabled: n(
    "VISE_AUDIT",
    1,
    "Audit log",
    "record an audit log in ~/.vise/audit.db (1 = on, 0 = off)",
    { min: 0 },
  ),
  maxCallTokens: n(
    "VISE_MAX_CALL_TOKENS",
    32_768,
    "Audit log",
    "stop a model call after this many tokens (0 = no limit)",
    { min: 0 },
  ),
  loopGuard: n(
    "VISE_LOOP_GUARD",
    1,
    "Audit log",
    "stop a model call that repeats itself (1 = on, 0 = off)",
    { min: 0 },
  ),
  loopRetries: n(
    "VISE_LOOP_RETRIES",
    1,
    "Audit log",
    "ask again (with a repeat penalty) when the guard stopped a call for repeating itself (0 = fail the turn)",
    { min: 0 },
  ),
  auditRetentionDays: n(
    "VISE_AUDIT_RETENTION_DAYS",
    0,
    "Audit log",
    "delete audit records older than this many days (0 = keep forever)",
    { min: 0 },
  ),
  saveEvery: n(
    "VISE_SAVE_EVERY_ROUNDS",
    25,
    COMPACT,
    "save the session every N rounds",
  ),
  progressEvery: n(
    "VISE_PROGRESS_EVERY_ROUNDS",
    50,
    COMPACT,
    "check progress every N rounds",
  ),
  maxSameStep: n(
    "VISE_GOAL_MAX_SAME_STEP",
    4,
    GOAL,
    "same step repeated before giving up",
  ),
  continuesBeforeAsking: n(
    "VISE_GOAL_CONTINUES_BEFORE_ASKING",
    8,
    GOAL,
    "automatic continues before asking",
  ),
  startupNoteLimit: n(
    "VISE_STARTUP_NOTE_LIMIT",
    30,
    TOOLS,
    "notes listed at start-up",
  ),
  treeMaxDepth: n("VISE_TREE_MAX_DEPTH", 5, TOOLS, "project tree depth"),
  treeMaxEntries: n(
    "VISE_TREE_MAX_ENTRIES",
    25,
    TOOLS,
    "project tree entries per folder",
  ),
  toolLinePartMax: n(
    "VISE_TOOL_LINE_PART_MAX",
    60,
    TOOLS,
    "tool line: characters per part",
  ),
  toolLineDetailMax: n(
    "VISE_TOOL_LINE_DETAIL_MAX",
    140,
    TOOLS,
    "tool line: characters of detail",
  ),
  resultMaxLines: n(
    "VISE_RESULT_MAX_LINES",
    250,
    TOOLS,
    "result lines shown before saving the rest",
  ),
  resultMaxChars: n(
    "VISE_RESULT_MAX_CHARS",
    20_000,
    TOOLS,
    "result characters shown before saving the rest",
  ),
  previewLines: n(
    "VISE_PREVIEW_LINES",
    40,
    TOOLS,
    "preview lines of a saved result",
  ),
  previewChars: n(
    "VISE_PREVIEW_CHARS",
    2_000,
    TOOLS,
    "preview characters of a saved result",
  ),
  searchMaxMatches: n(
    "VISE_SEARCH_MAX_MATCHES",
    100,
    TOOLS,
    "search matches returned",
  ),
  searchMaxMatchChars: n(
    "VISE_SEARCH_MAX_MATCH_CHARS",
    300,
    TOOLS,
    "characters per search match",
  ),
  tempStaleMs: n(
    "VISE_TEMP_STALE_MS",
    24 * 60 * 60 * 1000,
    TOOLS,
    "temp folder age before cleanup (ms)",
  ),
  tempHeartbeatMs: n(
    "VISE_TEMP_HEARTBEAT_MS",
    60 * 60 * 1000,
    TOOLS,
    "temp folder refresh interval (ms)",
  ),
  toolSearchMaxResults: n(
    "VISE_TOOL_SEARCH_MAX_RESULTS",
    5,
    TOOLS,
    "tool search results",
  ),
  mcpConnectTimeoutMs: n(
    "VISE_MCP_CONNECT_TIMEOUT_MS",
    15_000,
    MCP,
    "server connect timeout (ms)",
  ),
  mcpToolTimeoutMs: n(
    "VISE_MCP_TOOL_TIMEOUT_MS",
    120_000,
    MCP,
    "tool call timeout (ms)",
  ),
  maxImageBytes: n(
    "VISE_MAX_IMAGE_BYTES",
    10_000_000,
    TOOLS,
    "largest image (bytes)",
  ),
  maxPictures: n("VISE_MAX_PICTURES", 6, TOOLS, "images per message"),
  maxFileBytes: n(
    "VISE_WEB_MAX_FILE_BYTES",
    256 * 1024,
    TOOLS,
    "largest file shown in the explorer (bytes)",
  ),
  historyMaxEntries: n(
    "VISE_HISTORY_MAX_ENTRIES",
    400,
    TOOLS,
    "chat lines replayed on reload",
  ),
  shellTimeoutMs: n(
    "VISE_SHELL_TIMEOUT_MS",
    60_000,
    TOOLS,
    "foreground shell timeout (ms)",
  ),
  maxOutlineChars: n(
    "VISE_BROWSER_MAX_OUTLINE_CHARS",
    30_000,
    BROWSER,
    "page outline size (characters)",
  ),
  snapshotMaxElements: n(
    "VISE_BROWSER_MAX_ELEMENTS",
    200,
    BROWSER,
    "elements listed per page view",
    { restart: true },
  ),
  snapshotMaxScanned: n(
    "VISE_BROWSER_MAX_SCANNED",
    1_000,
    BROWSER,
    "elements scanned per page view",
    { restart: true },
  ),
  maxUploadBytes: n(
    "VISE_BROWSER_MAX_UPLOAD_BYTES",
    10_000_000,
    BROWSER,
    "largest upload (bytes)",
  ),
  waitPollMs: n("VISE_WAIT_POLL_MS", 250, BROWSER, "wait: poll interval (ms)"),
  waitQuietMs: n(
    "VISE_WAIT_QUIET_MS",
    600,
    BROWSER,
    "wait: quiet time to count as idle (ms)",
  ),
  waitMinIdleMs: n(
    "VISE_WAIT_MIN_IDLE_MS",
    1_500,
    BROWSER,
    "wait: shortest idle wait (ms)",
  ),
  waitProbeTimeoutMs: n(
    "VISE_WAIT_PROBE_TIMEOUT_MS",
    2_000,
    BROWSER,
    "wait: one probe timeout (ms)",
  ),
  waitDefaultSeconds: n(
    "VISE_WAIT_DEFAULT_SECONDS",
    10,
    BROWSER,
    "wait: default timeout (s)",
  ),
  waitMaxSeconds: n(
    "VISE_WAIT_MAX_SECONDS",
    60,
    BROWSER,
    "wait: longest timeout (s)",
  ),
  tabSettleMs: n(
    "VISE_TAB_SETTLE_MS",
    300,
    BROWSER,
    "new-tab detection delay (ms)",
  ),
  chromiumLoadTimeoutMs: n(
    "VISE_CHROMIUM_LOAD_TIMEOUT_MS",
    15_000,
    BROWSER,
    "Chromium page load timeout (ms)",
  ),
  chromiumLaunchTimeoutMs: n(
    "VISE_CHROMIUM_LAUNCH_TIMEOUT_MS",
    15_000,
    BROWSER,
    "Chromium launch timeout (ms)",
  ),
  firefoxLoadTimeoutMs: n(
    "VISE_FIREFOX_LOAD_TIMEOUT_MS",
    15_000,
    BROWSER,
    "Firefox page load timeout (ms)",
  ),
  firefoxLaunchTimeoutMs: n(
    "VISE_FIREFOX_LAUNCH_TIMEOUT_MS",
    20_000,
    BROWSER,
    "Firefox launch timeout (ms)",
  ),
  firefoxTitleTimeoutMs: n(
    "VISE_FIREFOX_TITLE_TIMEOUT_MS",
    1_500,
    BROWSER,
    "Firefox title lookup timeout (ms)",
  ),
  playwrightTimeoutMs: n(
    "VISE_PLAYWRIGHT_TIMEOUT_MS",
    30_000,
    BROWSER,
    "browser_run_code timeout (ms)",
  ),
  liveViewFrameMs: n(
    "VISE_LIVE_VIEW_FRAME_MS",
    200,
    BROWSER,
    "Firefox live view frame interval (ms)",
  ),
  extensionCallTimeoutMs: n(
    "VISE_EXTENSION_CALL_TIMEOUT_MS",
    30_000,
    BROWSER,
    "Firefox extension call timeout (ms)",
  ),
  tabLimit: n("VISE_TAB_LIMIT", 5, BROWSER, "tabs the extension can control"),
  terminalShell: {
    env: "VISE_TERMINAL_SHELL",
    def: "powershell.exe -NoLogo",
    group: TERMINAL,
    label: "shell command",
  },
  terminalScrollbackKb: n(
    "VISE_TERMINAL_SCROLLBACK_KB",
    256,
    TERMINAL,
    "output kept for a reloaded page (KB)",
  ),
  terminalIdleMinutes: n(
    "VISE_TERMINAL_IDLE_MINUTES",
    10,
    TERMINAL,
    "minutes a shell lives on with no page open",
  ),
} as const satisfies Record<string, Spec>;

export type SettingKey = keyof typeof SPEC;

type Values = {
  -readonly [K in SettingKey]: (typeof SPEC)[K]["def"] extends string
    ? string
    : number;
};

export type Config = Readonly<Values> & { readonly llmChatUrl: string };

const processEnv: Record<string, string | undefined> =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};

/** The values from the settings file, by variable name. */
let fileValues: Record<string, string> = {};

function resolve(spec: Spec): string | number {
  const raw = fileValues[spec.env]?.trim() || processEnv[spec.env]?.trim();
  if (!raw) return spec.def;
  if (typeof spec.def === "string") return raw;
  const value = Number(raw);
  return Number.isFinite(value) && value >= (spec.min ?? 0) ? value : spec.def;
}

function resolveAll(): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, spec] of Object.entries(SPEC)) out[key] = resolve(spec);
  out.llmBaseUrl = String(out.llmBaseUrl).replace(/\/+$/, "");
  return out;
}

let current = resolveAll();

/** Replace the values read from the settings file (by variable name) and re-resolve every setting. */
export function applySettings(values: Record<string, string>): void {
  fileValues = { ...values };
  current = resolveAll();
}

/** The value a setting has in the settings file right now ("" when it uses the default). */
export function fileValue(spec: Spec): string {
  return fileValues[spec.env]?.trim() ?? "";
}

export const config: Config = Object.defineProperties(
  {},
  {
    ...Object.fromEntries(
      Object.keys(SPEC).map((key) => [
        key,
        { enumerable: true, get: () => current[key] },
      ]),
    ),
    llmChatUrl: {
      enumerable: true,
      get: () => `${String(current.llmBaseUrl)}/v1/chat/completions`,
    },
  },
) as Config;
