/**
 * Dark/light theme: applies the choice to `<html data-theme>`, persists the
 * user's explicit pick in localStorage, and otherwise follows the OS
 * preference (also live, so switching the OS theme is mirrored).
 *
 * The CSS side reads the attribute: base.css defines the design tokens for
 * `:root` (dark) and `:root[data-theme="light"]`.
 */

const STORAGE_KEY = "bassface-theme";

export type Theme = "dark" | "light";

const lightQuery = window.matchMedia("(prefers-color-scheme: light)");

function systemTheme(): Theme {
  return lightQuery.matches ? "light" : "dark";
}

function apply(theme: Theme, persist = false): void {
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem(STORAGE_KEY, theme);
}

/** Apply the initial theme before first paint; called from main.tsx. */
export function initTheme(): void {
  const stored = localStorage.getItem(STORAGE_KEY);
  apply(stored === "light" || stored === "dark" ? stored : systemTheme());
  // While the user has not picked a side, follow OS-level changes.
  lightQuery.addEventListener("change", (e) => {
    if (!localStorage.getItem(STORAGE_KEY)) apply(e.matches ? "light" : "dark");
  });
}

/** Current theme as applied to the document root. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Flip dark ↔ light and persist the user's explicit choice. */
export function toggleTheme(): void {
  apply(currentTheme() === "dark" ? "light" : "dark", true);
}
