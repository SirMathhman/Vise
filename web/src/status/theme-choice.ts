export type ThemeChoice =
  | "system"
  | "light"
  | "dark"
  | "forest"
  | "volcano"
  | "underwater";

/** The resolved value that appears on `data-theme`. */
export type ResolvedTheme = "light" | "dark" | "forest" | "volcano" | "underwater";

/**
 * Every choice with its label, in menu order: the one list the View menu and
 * the settings page draw (`index.html`'s inline script repeats the explicit
 * names because it must run before this bundle loads).
 */
export const THEME_CHOICES: readonly (readonly [ThemeChoice, string])[] = [
  ["system", "Match system"],
  ["light", "Light"],
  ["dark", "Dark"],
  ["forest", "Forest"],
  ["volcano", "Volcano"],
  ["underwater", "Underwater"],
];

const EXPLICIT: readonly string[] = THEME_CHOICES.map(([value]) => value).filter((value) => value !== "system");

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
