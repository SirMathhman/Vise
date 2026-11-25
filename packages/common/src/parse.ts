import type { z } from "zod";
import type { Result } from "./result";
import { err, ok } from "./result";

/**
 * The text was not JSON at all.
 */
export interface NotJsonError {
  /** The kind of failure. */
  kind: "notJson";
}

/**
 * The value parsed but does not match the schema. The path names the field that failed.
 */
export interface WrongShapeError {
  /** The kind of failure. */
  kind: "wrongShape";
  /** The dotted path to the field that failed, or empty for the whole value. */
  path: string;
  /** What is wrong with that field. */
  message: string;
}

/**
 * Why a value could not be read. Callers match on kind, and describeParseError turns it into text.
 */
export type ParseError = NotJsonError | WrongShapeError;

/**
 * Checks an untrusted value against a zod schema.
 *
 * @param schema The schema the value must match.
 * @param value The untrusted value.
 * @returns The checked value, or the reason it does not match.
 */
export function parseValue<S extends z.ZodType>(
  schema: S,
  value: unknown,
): Result<z.output<S>, ParseError> {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return ok(parsed.data);
  }
  const issue = parsed.error.issues.at(0);
  return err({
    kind: "wrongShape",
    path: (issue?.path ?? []).map(String).join("."),
    message: issue?.message ?? "Unexpected format",
  });
}

/**
 * Turns JSON text into a checked value. Every deserialization goes through here.
 *
 * @param schema The schema the value must match.
 * @param text The untrusted JSON text.
 * @returns The checked value, or the reason the text could not be read.
 */
export function parseJson<S extends z.ZodType>(
  schema: S,
  text: string,
): Result<z.output<S>, ParseError> {
  let value: unknown;
  try {
    // The only JSON.parse in the code base. Its result is checked by the schema below.
    // eslint-disable-next-line no-restricted-properties
    value = JSON.parse(text);
  } catch {
    return err({ kind: "notJson" });
  }
  return parseValue(schema, value);
}

/**
 * User-facing text for a parse failure. A wrong shape names the field that failed.
 *
 * @param error The parse failure to describe.
 * @returns The user-facing text.
 */
export function describeParseError(error: ParseError): string {
  if (error.kind === "notJson") {
    return "not JSON";
  }
  return error.path === "" ? error.message : `${error.path}: ${error.message}`;
}
