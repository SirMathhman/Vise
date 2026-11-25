import { randomUUID } from "node:crypto";
import { MAX_CHARS, startProcess } from "./run";

/**
 * A program that keeps running after the caller stops waiting for it. Its output is collected
 * as it arrives, so it can be read before the program finishes.
 */
export interface BackgroundJob {
  /** The id the caller uses to read the job later. */
  id: string;
  /** The container to remove when the job is stopped, when the program runs in one. */
  containerName: string | undefined;
  /** The running process. */
  proc: ReturnType<typeof startProcess>;
  /** The output so far, cut to the character limit. */
  output: string;
  /** Whether the output was cut, which stops the program. */
  cut: boolean;
  /** The exit code, once the program has finished. */
  code: number | undefined;
  /** Resolves once the program has finished and its output is read. */
  done: Promise<void>;
}

// Every job started and not yet stopped, keyed by id.
const jobs = new Map<string, BackgroundJob>();

// Stops a job's program. A container is removed too, since stopping only the podman client
// would leave it running until its own limit.
function stopJob(job: BackgroundJob): void {
  job.proc.kill();
  if (job.containerName !== undefined) {
    try {
      Bun.spawn(["podman", "rm", "-f", job.containerName], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // Podman is not reachable; there is no container to remove.
    }
  }
}

// Reads one output stream into the job. Past the limit the job stops, and the rest is discarded.
async function collect(job: BackgroundJob, stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return;
    }
    if (job.cut) {
      continue;
    }
    job.output += decoder.decode(chunk.value, { stream: true });
    if (job.output.length > MAX_CHARS) {
      job.output = `${job.output.slice(0, MAX_CHARS)}\n... cut at ${String(MAX_CHARS)} characters`;
      job.cut = true;
      stopJob(job);
    }
  }
}

/**
 * Starts a program that may outlive the caller's wait. It is stopped when its lifetime ends, if
 * it has not finished by then.
 *
 * @param argv The program and its arguments.
 * @param cwd The folder the program runs in.
 * @param lifetimeMs How long the program may run in total.
 * @param containerName The container the program runs in, if any.
 * @returns The job, registered under its id until it is stopped.
 */
export function startBackground(
  argv: string[],
  cwd: string,
  lifetimeMs: number,
  containerName?: string,
): BackgroundJob {
  const job: BackgroundJob = {
    id: randomUUID(),
    containerName,
    proc: startProcess(argv, cwd),
    output: "",
    cut: false,
    code: undefined,
    done: Promise.resolve(),
  };
  jobs.set(job.id, job);
  const limit = setTimeout(() => {
    stopJob(job);
  }, lifetimeMs);
  job.done = Promise.all([
    collect(job, job.proc.stdout),
    collect(job, job.proc.stderr),
    job.proc.exited,
  ]).then(([, , code]) => {
    job.code = code;
    clearTimeout(limit);
  });
  return job;
}

/**
 * Waits for a job to finish, for at most a while.
 *
 * @param job The job to wait for.
 * @param ms The longest time to wait.
 * @returns True when the job finished in time; false when it is still running.
 */
export async function waitFor(
  job: BackgroundJob,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  const finished = job.done.then(() => true);
  const result = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  return result;
}

/**
 * The job with this id, if it is still registered.
 *
 * @param id The job's id.
 * @returns The job, or undefined when no job has that id.
 */
export function findJob(id: string): BackgroundJob | undefined {
  return jobs.get(id);
}

/**
 * Stops every job that is still running and forgets all jobs. Called when the conversation ends.
 */
export function stopAllJobs(): void {
  for (const job of jobs.values()) {
    if (job.code === undefined) {
      stopJob(job);
    }
  }
  jobs.clear();
}
