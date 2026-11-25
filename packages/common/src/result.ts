/**
 * A successful Result, holding its value.
 */
export interface Success<T> {
  /** Always true for a success. */
  ok: true;
  /** The successful value. */
  value: T;
}

/**
 * A failed Result, holding its error.
 */
export interface Failure<E> {
  /** Always false for a failure. */
  ok: false;
  /** The error. */
  error: E;
}

/**
 * A value or an error, returned instead of thrown.
 */
export type Result<T, E> = Success<T> | Failure<E>;

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
