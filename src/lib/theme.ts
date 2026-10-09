export type Theme = "system" | "light" | "dark";

const KEY = "gitui.theme";
const THEMES: Theme[] = ["system", "light", "dark"];

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return THEMES.includes(stored as Theme) ? (stored as Theme) : "system";
  } catch {
    return "system";
  }
}

/** Applies `theme` to the document and remembers it. */
export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be unavailable; the choice then lasts for this session.
  }
}

/** The theme that comes after `theme` when cycling with one button. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

/** Keeps a "system" theme in sync with the OS; returns the unsubscribe function. */
export function followSystemTheme(getTheme: () => Theme): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getTheme() === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
