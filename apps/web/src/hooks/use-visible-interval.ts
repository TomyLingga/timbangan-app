"use client";

import { useEffect, useEffectEvent } from "react";

/**
 * Calls `tick` every `ms` while the tab is visible, and once right away when
 * the tab becomes visible again. Nothing runs in a hidden tab.
 */
export function useVisibleInterval(tick: () => void, ms: number, enabled = true): void {
  const onTick = useEffectEvent(tick);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => onTick(), ms);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        onTick();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms, enabled]);
}
