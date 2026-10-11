export type ThemeChoice =
  | "system"
  | "light"
  | "dark"
  | "forest"
  | "volcano"
  | "underwater";

/** The resolved value that appears on `data-theme`. */
export type ResolvedTheme = "light" | "dark" | "forest" | "volcano" | "underwater";

const EXPLICIT: readonly string[] = ["light", "dark", "forest", "volcano", "underwater"];

/** The colours to use for a choice: "system" follows the operating system. */
export function resolveTheme(
  choice: ThemeChoice,
  systemDark: boolean,
): ResolvedTheme {
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}

/** A stored value as a choice; anything unknown (or nothing) is "system". */
export function parseChoice(value: string | null): ThemeChoice {
  return value !== null && EXPLICIT.includes(value) ? (value as ThemeChoice) : "system";
}
