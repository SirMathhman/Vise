import type { ViseError } from "../core/errors.ts";

/**
 * HTTP statuses that mean "try again in a moment": the request was fine, the
 * server (or the hosted provider's upstream) was busy, rate limiting, or just
 * failed over. A 4xx that says the request itself is wrong is never retried.
 */
const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);

/** Whether a failed call is worth asking again as it was. */
export function isTransient(error: ViseError): boolean {
  return error.kind === "http" && TRANSIENT_STATUSES.has(error.status);
}

/** A failure the provider reported after the stream began, as the HTTP error it would have been had it come first. */
export function streamFailureError(failure: { status: number; message: string }): ViseError {
  const body = JSON.stringify({ error: { message: failure.message } });
  return { kind: "http", status: failure.status, body };
}

/** How long to wait before retry number `attempt` (0 for the first): 1 s, 3 s, 9 s, capped at 10 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 3 ** attempt, 10_000);
}

/** Wait `ms`, ending early (not with an error) when `signal` aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
