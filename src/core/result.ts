export interface Ok<T> {
  ok: true;
  value: T;
}

export interface Err<E = Error> {
  ok: false;
  error: E;
}

// A value or a failure, returned instead of thrown.
export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E = Error>(error: E): Err<E> {
  return { ok: false, error };
}
