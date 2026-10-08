/**
 * Settings read from the environment (Bun loads `.env` on start). Every one has
 * a default, and a value that is missing, not a number or below its minimum
 * falls back to the default, so a bad `.env` never stops Vise starting.
 * `.env.example` lists them all. Edge code only: the pure core takes values as
 * parameters. Also bundled into the Firefox extension, where there is no
 * `process`, so the defaults apply.
 */
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};

function text(name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function num(name: string, fallback: number, min = 1): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

const llmBaseUrl = text("VISE_LLM_URL", "http://localhost:8080").replace(
  /\/+$/,
  "",
);

export const config = {
  // LLM server (llama.cpp, OpenAI-compatible)
  llmBaseUrl,
  llmChatUrl: `${llmBaseUrl}/v1/chat/completions`,
  llmApiKey: text("VISE_LLM_API_KEY", ""),
  llmModel: text(
    "VISE_LLM_MODEL",
    "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:QATFA",
  ),
  slotRequestTimeoutMs: num("VISE_SLOT_REQUEST_TIMEOUT_MS", 5_000),
  // Web server
  port: num("PORT", 3000),
  // Context compaction and long turns
  recentTurnsToKeep: num("VISE_RECENT_TURNS_TO_KEEP", 2),
  roundsToKeep: num("VISE_ROUNDS_TO_KEEP", 10),
  tailShare: num("VISE_TAIL_SHARE", 0.25, 0.05),
  inTurnCompactionThreshold: num("VISE_IN_TURN_COMPACTION_THRESHOLD", 0.75, 0.1),
  compactionThreshold: num("VISE_COMPACTION_THRESHOLD", 0.9, 0.1),
  saveEvery: num("VISE_SAVE_EVERY_ROUNDS", 25),
  progressEvery: num("VISE_PROGRESS_EVERY_ROUNDS", 50),
  // Goal checking
  maxSameStep: num("VISE_GOAL_MAX_SAME_STEP", 4),
  continuesBeforeAsking: num("VISE_GOAL_CONTINUES_BEFORE_ASKING", 8),
  // Prompt and display size
  startupNoteLimit: num("VISE_STARTUP_NOTE_LIMIT", 30),
  treeMaxDepth: num("VISE_TREE_MAX_DEPTH", 5),
  treeMaxEntries: num("VISE_TREE_MAX_ENTRIES", 25),
  toolLinePartMax: num("VISE_TOOL_LINE_PART_MAX", 60),
  toolLineDetailMax: num("VISE_TOOL_LINE_DETAIL_MAX", 140),
  // Tool output and files
  resultMaxLines: num("VISE_RESULT_MAX_LINES", 250),
  resultMaxChars: num("VISE_RESULT_MAX_CHARS", 20_000),
  previewLines: num("VISE_PREVIEW_LINES", 40),
  previewChars: num("VISE_PREVIEW_CHARS", 2_000),
  searchMaxMatches: num("VISE_SEARCH_MAX_MATCHES", 100),
  searchMaxMatchChars: num("VISE_SEARCH_MAX_MATCH_CHARS", 300),
  tempStaleMs: num("VISE_TEMP_STALE_MS", 24 * 60 * 60 * 1000),
  tempHeartbeatMs: num("VISE_TEMP_HEARTBEAT_MS", 60 * 60 * 1000),
  toolSearchMaxResults: num("VISE_TOOL_SEARCH_MAX_RESULTS", 5),
  maxImageBytes: num("VISE_MAX_IMAGE_BYTES", 10_000_000),
  maxPictures: num("VISE_MAX_PICTURES", 6),
  maxFileBytes: num("VISE_WEB_MAX_FILE_BYTES", 256 * 1024),
  historyMaxEntries: num("VISE_HISTORY_MAX_ENTRIES", 400),
  shellTimeoutMs: num("VISE_SHELL_TIMEOUT_MS", 60_000),
  // Browser tools
  maxOutlineChars: num("VISE_BROWSER_MAX_OUTLINE_CHARS", 30_000),
  snapshotMaxElements: num("VISE_BROWSER_MAX_ELEMENTS", 200),
  snapshotMaxScanned: num("VISE_BROWSER_MAX_SCANNED", 1_000),
  maxUploadBytes: num("VISE_BROWSER_MAX_UPLOAD_BYTES", 10_000_000),
  waitPollMs: num("VISE_WAIT_POLL_MS", 250),
  waitQuietMs: num("VISE_WAIT_QUIET_MS", 600),
  waitMinIdleMs: num("VISE_WAIT_MIN_IDLE_MS", 1_500),
  waitProbeTimeoutMs: num("VISE_WAIT_PROBE_TIMEOUT_MS", 2_000),
  waitDefaultSeconds: num("VISE_WAIT_DEFAULT_SECONDS", 10),
  waitMaxSeconds: num("VISE_WAIT_MAX_SECONDS", 60),
  tabSettleMs: num("VISE_TAB_SETTLE_MS", 300),
  chromiumLoadTimeoutMs: num("VISE_CHROMIUM_LOAD_TIMEOUT_MS", 15_000),
  chromiumLaunchTimeoutMs: num("VISE_CHROMIUM_LAUNCH_TIMEOUT_MS", 15_000),
  firefoxLoadTimeoutMs: num("VISE_FIREFOX_LOAD_TIMEOUT_MS", 15_000),
  firefoxLaunchTimeoutMs: num("VISE_FIREFOX_LAUNCH_TIMEOUT_MS", 20_000),
  firefoxTitleTimeoutMs: num("VISE_FIREFOX_TITLE_TIMEOUT_MS", 1_500),
  playwrightTimeoutMs: num("VISE_PLAYWRIGHT_TIMEOUT_MS", 30_000),
  liveViewFrameMs: num("VISE_LIVE_VIEW_FRAME_MS", 200),
  extensionCallTimeoutMs: num("VISE_EXTENSION_CALL_TIMEOUT_MS", 30_000),
} as const;
