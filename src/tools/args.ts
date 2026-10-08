/**
 * A number a model sent as a tool argument. Models often send a number as text
 * ("250" for 250), and ignoring that silently makes a range read return the
 * wrong part of a file, so a numeric string counts. Returns undefined when the
 * argument was not given, and NaN when it was given but is not a number.
 */
export function numberArg(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value))
    return Number(value);
  return Number.NaN;
}

/** The message for an argument that was given but is not a number, or undefined when it is fine. */
export function badNumber(name: string, value: unknown): string | undefined {
  return Number.isNaN(numberArg(value))
    ? `error: ${name} must be a number (got ${JSON.stringify(value)})`
    : undefined;
}
