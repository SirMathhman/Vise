// Pre-session command execution. Runs a shell command (via powershell) before
// the conversation begins. Returns a structured result; does not print or
// spawn anything else. The loop owns rendering and seeding the conversation.
//
// This is the only startup-time exception to invariant 5 (tools are the only
// modules that execute external processes); it runs before any turn begins
// and returns output + exit code to the loop.

const OUTPUT_BUDGET = 16_000;
const OUTPUT_MARKER = "\n…(truncated)";

export type PreSessionResult = {
  output: string;
  exitCode: number;
};

export async function runPreSessionCmd(cmd: string): Promise<PreSessionResult> {
  const proc = Bun.spawn(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trim());
  if (stderr.trim()) parts.push(stderr.trim());
  const combined = parts.join("\n");

  // Bound the output so a chatty command cannot blow the context window.
  let output = combined;
  if (output.length > OUTPUT_BUDGET) {
    output = output.slice(0, OUTPUT_BUDGET) + OUTPUT_MARKER;
  }
  return { output, exitCode };
}
