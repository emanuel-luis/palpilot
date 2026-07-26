const KEY = "palpilot.theme";

export type Theme = "light" | "dark" | "system";

function readStored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* private mode */ }
  return "system";
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function initTheme() {
  apply(readStored());
}

export function getTheme(): Theme {
  return readStored();
}

export function resolvedTheme(): "light" | "dark" {
  const t = readStored();
  if (t !== "system") return t;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export function toggleTheme(): "light" | "dark" {
  const next: "light" | "dark" = resolvedTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
  apply(next);
  window.dispatchEvent(new CustomEvent("palpilot:theme"));
  return next;
}
