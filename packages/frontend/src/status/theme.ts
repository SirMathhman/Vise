import { storage } from "../storage.ts";
import { parseChoice, resolveTheme, type ThemeChoice } from "./theme-choice.ts";

export type { ThemeChoice };

/** Where the choice is remembered in this browser (index.html reads it before the first paint too). */
const KEY = "vise-theme";

const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

let choice: ThemeChoice = parseChoice(storage.get(KEY));

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
    // Storage may be unavailable (private window): the choice then lasts for this page.
    if (next === "system") storage.remove(KEY);
    else storage.set(KEY, next);
    apply();
  },
  onChange(listener: () => void): void {
    listeners.add(listener);
  },
};

apply();
