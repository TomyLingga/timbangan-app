// Loading data from the API for a screen. With a cache key, the last answer is kept on the phone and shown,
// with the time it was fetched, when there is no signal (docs/fase-5-rancangan.md, section 5).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

export interface Remote<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  refreshing: boolean;
  /** When the shown data came from the server; null before the first answer. */
  fetchedAt: Date | null;
  /** True when the shown data is the stored copy because the last call failed. */
  stale: boolean;
  reload(): Promise<void>;
}

interface Options {
  cacheKey?: string | null;
  /** Reload this often while the screen is in focus. */
  intervalMs?: number;
  enabled?: boolean;
}

export function useRemote<T>(load: () => Promise<T>, deps: unknown[], options: Options = {}): Remote<T> {
  const { cacheKey = null, intervalMs, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const run = useCallback(
    async (manual: boolean) => {
      if (!enabled) return;
      const mine = ++generation.current;
      if (manual) setRefreshing(true);
      try {
        const answer = await loadRef.current();
        if (mine !== generation.current) return;
        const at = new Date();
        setData(answer);
        setError(null);
        setFetchedAt(at);
        setStale(false);
        if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify({ at: at.toISOString(), data: answer })).catch(() => undefined);
      } catch (caught) {
        if (mine !== generation.current) return;
        setError(caught);
        setStale(true);
      } finally {
        if (mine === generation.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cacheKey, enabled, ...deps],
  );

  // the stored copy first, then the server
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      if (cacheKey) {
        const stored = await AsyncStorage.getItem(cacheKey).catch(() => null);
        if (stored && alive) {
          const parsed = JSON.parse(stored) as { at: string; data: T };
          setData((current) => current ?? parsed.data);
          setFetchedAt((current) => current ?? new Date(parsed.at));
        }
      }
      if (alive) await run(false);
    })();
    return () => {
      alive = false;
    };
  }, [run, cacheKey]);

  useFocusEffect(
    useCallback(() => {
      if (!intervalMs) return undefined;
      const timer = setInterval(() => void run(false), intervalMs);
      return () => clearInterval(timer);
    }, [run, intervalMs]),
  );

  return { data, error, loading, refreshing, fetchedAt, stale, reload: () => run(true) };
}
