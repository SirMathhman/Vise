import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { startBackground, stopAllJobs, waitFor } from "../../src/process/jobs";

describe("background jobs", () => {
  test("a job still running after the first wait finishes later, with its output", async () => {
    const job = startBackground(
      ["bash", "-c", "sleep 1; echo finished"],
      tmpdir(),
      10_000,
    );
    expect(await waitFor(job, 100)).toBe(false);
    expect(await waitFor(job, 5_000)).toBe(true);
    expect(job.code).toBe(0);
    expect(job.output).toContain("finished");
  });

  test("stopping all jobs ends a running one", async () => {
    const job = startBackground(["bash", "-c", "sleep 30"], tmpdir(), 60_000);
    stopAllJobs();
    expect(await waitFor(job, 5_000)).toBe(true);
    expect(job.code).not.toBe(0);
  });
});
