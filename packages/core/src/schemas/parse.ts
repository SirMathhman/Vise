import type { Result, ViseError } from "../errors.ts";
import { z } from "zod";

/**
 * Parse `data` against `schema` and return the result as `Result<T>`.
 * On failure the error is `{ kind: "malformed", body: <readable issues> }`.
 */
export function parse<T>(schema: z.ZodType<T>, data: unknown): Result<T> {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  const body = formatIssues(result.error.issues, data);
  return { ok: false, error: { kind: "malformed", body } satisfies ViseError };
}

/**
 * Parse a JSON string and validate the result against a zod schema.
 * Combines JSON.parse (step 1) and schema validation (step 2) into a
 * single Result. Returns a ViseError on JSON syntax failure or schema
 * mismatch.
 */
export function parseJson<T>(schema: z.ZodType<T>, json: string): Result<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      error: { kind: "malformed", body: `invalid JSON: ${json.slice(0, 200)}` } satisfies ViseError,
    };
  }
  return parse(schema, parsed);
}

/** Format zod issues into a human-readable string with the raw input. */
function formatIssues(issues: z.core.$ZodIssue[], data: unknown): string {
  const lines = issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  let raw: string;
  if (typeof data === "string") raw = data;
  else {
    try {
      raw = JSON.stringify(data) ?? "undefined";
    } catch {
      raw = String(data);
    }
  }
  const truncated = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
  return `${lines.join("\n")}\n---\n${truncated}`;
}
