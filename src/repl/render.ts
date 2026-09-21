// Prompt, answer, and error rendering. Pure formatting; no fetch.
export function renderPrompt(): void {
  process.stdout.write("you> ");
}

export function renderReply(answer: string): void {
  console.log(`\nassistant> ${answer || "(empty response)"}\n`);
}

export function renderError(message: string): void {
  console.error(`error: ${message}`);
}

export function renderCommand(result: {
  lines: string[];
  isError?: boolean;
}): void {
  const write = result.isError ? console.error : console.log;
  write("");
  for (const line of result.lines) write(line);
  write("");
}

// Renders a labeled hook result. The label identifies which hook produced
// the output (e.g. "pre-session", "lint", "typecheck"). On non-zero exit,
// a warning is printed after the output.
export function renderHook(
  label: string,
  output: string,
  exitCode: number,
): void {
  console.log(`\n${label}:\n${output}\n`);
  if (exitCode !== 0) {
    console.error(`${label}: command exited with code ${exitCode}`);
  }
}
