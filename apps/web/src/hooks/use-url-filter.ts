"use client";

import { useEffect, useState } from "react";

function readParam(key: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(key) ?? "";
}

/**
 * A list filter kept in the address bar, so a filtered list can be linked to
 * and survives a reload: `?status=SUBMITTED`. The value starts from the URL
 * and every change replaces the URL without a navigation. List pages render
 * only after sign-in, on the client, so the first value never differs from
 * a server render.
 */
export function useUrlFilter(key: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => readParam(key));

  useEffect(() => {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [key, value]);

  return [value, setValue];
}
