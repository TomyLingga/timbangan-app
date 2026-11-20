"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";

interface Settled<T> {
  key: string;
  attempt: number;
  at: number;
  result: { ok: true; data: T } | { ok: false; error: unknown };
}

export interface ApiQuery<T> {
  /** Data to show. While a new request is out this can be the previous answer. */
  data: T | undefined;
  /** Failure of the current request, if it has failed. */
  error: unknown;
  hasError: boolean;
  /** The current request has not answered yet. */
  isLoading: boolean;
  /** `data` belongs to an earlier request and a newer one is on its way. */
  isStale: boolean;
  /** Time (ms since epoch) the current request answered. */
  settledAt: number | null;
  reload: () => void;
}

/**
 * Fetches when `key` changes and aborts the request it replaces. Loading is
 * derived from "has the current key answered", so no state is set inside the
 * effect body. Pass `null` as the key to skip fetching.
 */
export function useApiQuery<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: { keepPrevious?: boolean } = {},
): ApiQuery<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const runFetcher = useEffectEvent(fetcher);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    runFetcher(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setSettled({ key, attempt, at: Date.now(), result: { ok: true, data } });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setSettled({ key, attempt, at: Date.now(), result: { ok: false, error } });
        }
      },
    );
    return () => controller.abort();
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  const current = settled !== null && settled.key === key && settled.attempt === attempt ? settled : null;
  const isLoading = key !== null && current === null;

  let data: T | undefined;
  let isStale = false;
  if (current?.result.ok) {
    data = current.result.data;
  } else if (isLoading && options.keepPrevious && settled?.result.ok) {
    data = settled.result.data;
    isStale = true;
  }

  const error = current && !current.result.ok ? current.result.error : undefined;

  return {
    data,
    error,
    hasError: current !== null && !current.result.ok,
    isLoading,
    isStale,
    settledAt: current?.at ?? null,
    reload,
  };
}
