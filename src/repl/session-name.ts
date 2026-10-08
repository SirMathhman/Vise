/**
 * Derive an auto-save session name from a user-typed message. Pure: no I/O,
 * no globals. Takes the message, trims, takes the first non-empty line,
 * replaces path separators and dots with hyphens, collapses consecutive
 * hyphens into one, drops leading/trailing hyphens, and truncates to 40
 * characters. Returns a non-empty string; falls back to "session" when the
 * result is blank after trimming.
 */
export function deriveSessionName(message: string): string {
  const trimmed = message.trim();
  if (trimmed === "") return "session";
  const firstLine = trimmed.split("\n")[0] ?? "";
  const sanitized = firstLine
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\./g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
  if (sanitized === "") return "session";
  const maxLen = 40;
  // Trim again after cutting, so the name never ends in a space.
  return sanitized.length > maxLen
    ? sanitized.slice(0, maxLen).trimEnd()
    : sanitized;
}
