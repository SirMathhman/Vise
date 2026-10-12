/**
 * The valid `reasoning_effort` levels, in the order they are presented to the
 * user. `default` keeps the chat template's built-in default; `none` disables
 * reasoning/thinking; the remaining levels are forwarded to the chat template
 * as-is. One source of truth for the terminal, the web page, and tests.
 */
export const REASONING_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
