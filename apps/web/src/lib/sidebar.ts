// Desktop sidebar width: an icon rail (the default), or widened to show its
// labels. A display preference kept in localStorage, applied as
// html[data-sidebar="full"] so CSS can lay out the shell before React runs.

export type SidebarMode = "rail" | "full";

const STORAGE_KEY = "sidebar";

/** Runs in <head> before first paint, next to the theme script. */
export const SIDEBAR_SCRIPT = `(function(){try{if(localStorage.getItem("${STORAGE_KEY}")==="full")document.documentElement.dataset.sidebar="full"}catch(e){}})()`;

const listeners = new Set<() => void>();

export function readSidebarMode(): SidebarMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "full" ? "full" : "rail";
  } catch {
    return "rail";
  }
}

export function setSidebarMode(mode: SidebarMode): void {
  try {
    if (mode === "full") window.localStorage.setItem(STORAGE_KEY, "full");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; the sidebar still changes for this page view.
  }
  applySidebarMode();
  for (const listener of listeners) listener();
}

export function applySidebarMode(): void {
  if (readSidebarMode() === "full") document.documentElement.dataset.sidebar = "full";
  else delete document.documentElement.dataset.sidebar;
}

export function subscribeSidebar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
