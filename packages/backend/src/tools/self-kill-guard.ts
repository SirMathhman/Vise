const KILL_VERBS = /\b(stop-process|spps|taskkill|kill|pskill)\b/i;
const OWN_NAMES = /\b(vise(-cli)?(\.exe)?|bun(\.exe)?)\b/i;

/**
 * Refuse a command that would kill the program running it: Windows will not let
 * a build overwrite a running exe, and stopping it by name (or by its own pid)
 * ends the agent mid-command. Returns the error text, or undefined when fine.
 */
export function selfKillRefusal(
  command: string,
  ownPids: readonly number[] = [process.pid, process.ppid],
): string | undefined {
  if (!KILL_VERBS.test(command)) return undefined;
  const byName = OWN_NAMES.test(command);
  const byPid = ownPids.some((pid) => new RegExp(`\\b${pid}\\b`).test(command));
  if (!byName && !byPid) return undefined;
  return (
    "error: refused: this command would stop the running Vise (or bun), which is the program running you. " +
    "Do not kill it. To rebuild Vise run `scripts/rebuild.ps1` (or `bun run build:exe`): it builds a copy and " +
    "swaps it in, which works while Vise runs; the new build takes effect when the user restarts Vise."
  );
}
