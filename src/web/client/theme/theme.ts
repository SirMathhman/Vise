// The page's theme: System (follow the operating system), Light, or Dark. The choice is the data-theme attribute of
// the page, which style.css reads, and it is kept in this browser's local storage so a reload keeps it.

const KEY = "vise.theme";
const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

const LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

// The theme control in the header: a select that sets the theme and keeps it.
export function themeControl(doc: Document): HTMLElement {
  const select = doc.createElement("select");
  select.className = "theme";
  select.setAttribute("aria-label", "Theme");
  for (const theme of THEMES) {
    const option = doc.createElement("option");
    option.value = theme;
    option.textContent = LABELS[theme];
    select.append(option);
  }
  const current = readTheme();
  select.value = current;
  applyTheme(doc, current);
  select.addEventListener("change", () => {
    const theme = isTheme(select.value) ? select.value : "system";
    applyTheme(doc, theme);
    writeTheme(theme);
  });
  return select;
}

// System removes the attribute, so the stylesheet follows the operating system. Light and Dark set it.
function applyTheme(doc: Document, theme: Theme): void {
  if (theme === "system") delete doc.documentElement.dataset.theme;
  else doc.documentElement.dataset.theme = theme;
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    return isTheme(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

function writeTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be unavailable; the theme then lasts for this page only.
  }
}
