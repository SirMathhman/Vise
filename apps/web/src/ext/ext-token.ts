import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The pairing secret for the Firefox extension's connection (`/ext`). The
 * server keeps one random token (in `~/.vise/ext-token`, so it survives
 * restarts) and only hands it to the Vise page itself; the sidebar page passes
 * it on to the extension. Without it, another extension or a local process that
 * merely sends a `moz-extension://` Origin cannot become the agent's hands.
 */

/** Read the token, creating it on first use. */
export function loadExtensionToken(
  file: string = join(homedir(), ".vise", "ext-token"),
): string {
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // no token yet
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** Compare tokens without leaking where they differ. */
export function tokensMatch(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
