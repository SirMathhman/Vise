import type { z } from "zod";
import type { Result } from "./result";
import { err, ok } from "./result";

/**
 * Why a value could not be read. Callers match on kind, and describeParseError turns it into text.
 */
export type ParseError =
  { kind: "notJson" } | { kind: "wrongShape"; path: string; message: string };

/**
 * Checks an untrusted value against a zod schema.
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
 */
export function describeParseError(error: ParseError): string {
  if (error.kind === "notJson") {
    return "not JSON";
  }
  return error.path === "" ? error.message : `${error.path}: ${error.message}`;
}
