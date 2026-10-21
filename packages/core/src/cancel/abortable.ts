import type { Result } from "../errors.ts";

/** The result of work that was stopped before it finished. */
export const INTERRUPTED = {
  ok: false,
  error: { kind: "interrupted" },
} as const satisfies Result<never>;

/**
 * Wait for `work`, but no longer than until `signal` aborts: then resolve at
 * once as interrupted, whatever the work does (it may ignore the signal, or
 * never finish). This is what makes stopping a turn independent of the
 * cooperation of the code underneath: every wait in a turn goes through it.
 * A rejection of `work` before the abort is passed on (callers catch it as
 * before); one after the abort is dropped. With no signal it only waits.
 */
export function abortable<T>(
  signal: AbortSignal | undefined,
  work: Promise<T> | T,
): Promise<Result<T>> {
  if (signal?.aborted) {
    // The work is abandoned; a later rejection must not surface as unhandled.
    void Promise.resolve(work).catch(() => undefined);
    return Promise.resolve(INTERRUPTED);
  }
  return new Promise<Result<T>>((resolve, reject) => {
    const onAbort = (): void => resolve(INTERRUPTED);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(work).then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        // After an abort the promise is already settled, so this is a no-op.
        reject(error);
      },
    );
  });
}

/** Like `abortable` for work that already returns a `Result`: one level, not a nested one. */
export async function abortableResult<T>(
  signal: AbortSignal | undefined,
  work: Promise<Result<T>> | Result<T>,
): Promise<Result<T>> {
  const raced = await abortable(signal, work);
  return raced.ok ? raced.value : raced;
}
