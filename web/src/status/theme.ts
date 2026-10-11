import { parseChoice, resolveTheme, type ThemeChoice } from "./theme-choice.ts";

export type { ThemeChoice };

/** Where the choice is remembered in this browser (index.html reads it before the first paint too). */
const KEY = "vise-theme";

const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function stored(): ThemeChoice {
  try {
    return parseChoice(localStorage.getItem(KEY));
  } catch {
    return "system";
  }
}

let choice: ThemeChoice = stored();

function apply(): void {
  document.documentElement.dataset["theme"] = resolveTheme(choice, media.matches);
  for (const listener of listeners) listener();
}

media.addEventListener("change", () => {
  if (choice === "system") apply();
});

/**
 * The page's light or dark colours: the user's choice (View → Theme or
 * settings), remembered per browser, or the system's when there is none.
 * Parts that copy colours once (the terminal) subscribe to changes.
 */
export const theme = {
  choice: (): ThemeChoice => choice,
  set(next: ThemeChoice): void {
    choice = next;
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Storage may be unavailable (private window): the choice lasts for this page.
    }
    apply();
  },
  onChange(listener: () => void): void {
    listeners.add(listener);
  },
};

apply();
