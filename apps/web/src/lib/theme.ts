// Light and dark theme. The default follows the system; a choice made with the
// toggle is kept in localStorage (a display preference, not session data).

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Runs in <head> before first paint so the page never flashes the wrong theme.
 * Must stay in step with applyTheme below.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${STORAGE_KEY}");var d=p==="dark"||(p!=="light"&&window.matchMedia("${DARK_QUERY}").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

const listeners = new Set<() => void>();

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(): void {
  const preference = readThemePreference();
  const dark = preference === "dark" || (preference === "system" && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage can be blocked; the theme still changes for this page view.
  }
  applyTheme();
  for (const listener of listeners) listener();
}

/** Subscribes to changes from the toggle, another tab, and the system setting. */
export function subscribeTheme(listener: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const sync = () => {
    applyTheme();
    listener();
  };
  listeners.add(listener);
  media.addEventListener("change", sync);
  window.addEventListener("storage", sync);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", sync);
    window.removeEventListener("storage", sync);
  };
}
