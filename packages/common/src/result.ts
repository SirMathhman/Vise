/**
 * A value or an error, returned instead of thrown.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Wraps a successful value in a Result.
 *
 * @param value The successful value.
 * @returns A successful Result holding the value.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Wraps an error in a Result.
 *
 * @param error The error.
 * @returns A failed Result holding the error.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
