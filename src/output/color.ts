/**
 * Terminal styling. All display code lives in `src/output/`; this is the
 * single place that decides whether ANSI codes are emitted. Codes are on by
 * default and turned off when stdout is not a TTY (piped output stays clean)
 * or when `NO_COLOR` is set. `FORCE_COLOR=1` overrides both, for tests or
 * terminals that advertise no TTY but still render codes.
 */
function isEnabled(): boolean {
  if (process.env.FORCE_COLOR === "1") return true;
  if (process.env.NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

/** Wrap `text` in the given SGR escape codes, or return it unchanged. */
function paint(open: string, close: string, text: string): string {
  return isEnabled() ? `${open}${text}${close}` : text;
}

/** Bold red — for error and failure text. */
export function red(text: string): string {
  return paint("\x1b[1;31m", "\x1b[0m", text);
}

/** Dim (faint) — for live progress counters and subagent output. */
export function dim(text: string): string {
  return paint("\x1b[2m", "\x1b[0m", text);
}

/** Cyan — for the REPL prompt marker. */
export function cyan(text: string): string {
  return paint("\x1b[36m", "\x1b[0m", text);
}
