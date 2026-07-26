import { useEffect, useState } from "react";

function currentPath(): string {
  const h = window.location.hash.replace(/^#/, "");
  return h || "/console";
}

export function useHashRoute(): string {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    function onChange() { setPath(currentPath()); }
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}

export function navigate(path: string): void {
  const next = path.startsWith("/") ? path : `/${path}`;
  if (window.location.hash === `#${next}`) return;
  window.location.hash = next;
}
