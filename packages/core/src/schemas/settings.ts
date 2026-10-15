/**
 * Validate a single settings value. `specDef` is the default from the SPEC
 * definition (a string for text settings, a number for numeric ones), and
 * `min` is the minimum allowed value for numeric settings.
 *
 * Returns a human-readable error message, or undefined when the value is fine.
 */
export function validateSettingValue(
  value: string,
  label: string,
  specDef: string | number,
  min?: number,
): string | undefined {
  if (/[\r\n]/.test(value)) return `${label}: must be one line`;
  if (typeof specDef === "string") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < (min ?? 0)) {
    return `${label}: needs a number of at least ${min ?? 0}`;
  }
  return undefined;
}
