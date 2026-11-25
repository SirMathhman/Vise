import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { executeCommand } from "./shell";

describe("executeCommand", () => {
  test("returns the exit code and the output", async () => {
    const result = await executeCommand(tmpdir(), "echo hello; exit 3");
    expect(result).toEqual({
      ok: true,
      value: "Exit code 3\nstdout:\nhello\n\nstderr:\n",
    });
  });

  test("stops a command that runs past the timeout", async () => {
    const result = await executeCommand(tmpdir(), "sleep 5", 200);
    expect(result).toEqual({
      ok: false,
      error: "The command was stopped after 0.2 seconds.",
    });
  });

  test("caps output from a command that prints without end, and returns promptly", async () => {
    const started = Date.now();
    const result = await executeCommand(tmpdir(), "yes", 10_000);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toContain("... cut at 20000 characters");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("does not pass credential-looking variables to the command", async () => {
    process.env.VISE_TEST_API_KEY = "secret-value";
    try {
      const result = await executeCommand(
        tmpdir(),
        'echo "${VISE_TEST_API_KEY:-unset}"',
      );
      expect(result.ok && result.value).toContain("unset");
      expect(result.ok && result.value).not.toContain("secret-value");
    } finally {
      delete process.env.VISE_TEST_API_KEY;
    }
  });
});
