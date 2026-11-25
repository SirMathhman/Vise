/**
 * A value or an error, returned instead of thrown.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Wraps a successful value in a Result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Wraps an error in a Result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
