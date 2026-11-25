import type { z } from "zod";
import type { Result } from "./result";
import { err, ok } from "./result";

// The error when text is not JSON at all. Shape failures carry the schema's message.
export const NOT_JSON = "not JSON";

// Checks an untrusted value against a zod schema.
export function parseValue<S extends z.ZodType>(
  schema: S,
  value: unknown,
): Result<z.output<S>, string> {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(parsed.error.issues[0]?.message ?? "Unexpected format");
}

// Turns JSON text into a checked value. Every deserialization goes through here.
export function parseJson<S extends z.ZodType>(
  schema: S,
  text: string,
): Result<z.output<S>, string> {
  let value: unknown;
  try {
    // The only JSON.parse in the code base. Its result is checked by the schema below.
    // eslint-disable-next-line no-restricted-properties
    value = JSON.parse(text);
  } catch {
    return err(NOT_JSON);
  }
  return parseValue(schema, value);
}
