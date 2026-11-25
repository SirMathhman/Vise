import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  outputOf,
  startBackground,
  stopAllJobs,
  waitFor,
} from "../../src/process/jobs";
import { cutNote } from "../../src/process/run";

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
    expect(outputOf(job)).toContain("finished");
  });

  test("stopping all jobs ends a running one", async () => {
    const job = startBackground(["bash", "-c", "sleep 30"], tmpdir(), 60_000);
    stopAllJobs();
    expect(await waitFor(job, 5_000)).toBe(true);
    expect(job.code).not.toBe(0);
  });

  test("a job whose output passes the limit is stopped, and its output ends with the cut note", async () => {
    const job = startBackground(
      ["bash", "-c", "head -c 30000 /dev/zero | tr '\\0' x"],
      tmpdir(),
      10_000,
    );
    expect(await waitFor(job, 5_000)).toBe(true);
    expect(job.capture.cut).toBe(true);
    expect(outputOf(job)).toEndWith(cutNote());
  });
});
