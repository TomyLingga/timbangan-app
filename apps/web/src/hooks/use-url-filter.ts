"use client";

import { useEffect, useState } from "react";

/**
 * A list filter kept in the address bar, so a filtered list can be linked to
 * and survives a reload: `?status=SUBMITTED`. The value starts from the URL
 * and every change replaces the URL without a navigation. List pages render
 * only after sign-in, on the client, so the first value never differs from
 * a server render.
 */
export function useUrlFilter(key: string): [string, (value: string) => void] {
  return useUrlParam(key, "");
}

/**
 * Like useUrlFilter, for a value whose default is not empty: the default
 * leaves the address bar, anything else (an emptied field too) is written to
 * it, so a reload gives back what was on the screen.
 */
export function useUrlParam(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return fallback;
    return new URLSearchParams(window.location.search).get(key) ?? fallback;
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (value === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [key, value, fallback]);

  return [value, setValue];
}
