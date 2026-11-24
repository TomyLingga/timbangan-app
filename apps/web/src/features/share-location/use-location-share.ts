"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { isApiError } from "@/lib/api-client";
import { pointFromPosition, SendQueue } from "@/lib/gps";
import { api } from "@/lib/session";

const CHECK_MS = 1000;

export interface ShareState {
  sharing: boolean;
  startedAt: number | null;
  /** When the API last stored a batch. */
  lastSentAt: number | null;
  /** The newest position the phone gave. */
  lastFix: { at: number; accuracyM: number | null } | null;
  /** Points waiting for signal. */
  waiting: number;
  dropped: number;
  /** The browser or the driver refused the location. */
  denied: boolean;
  /** The API closed sharing (409 SHARING_CLOSED). */
  closed: boolean;
  /** The API no longer knows the link (404). */
  unknown: boolean;
  /** The last send failed for want of signal or server. */
  offline: boolean;
  /** The phone has not given a position yet, or lost it for a while. */
  searching: boolean;
  /** "on": the screen is kept on; "none": the browser cannot. */
  wakeLock: "on" | "off" | "none";
}

const IDLE: ShareState = {
  sharing: false,
  startedAt: null,
  lastSentAt: null,
  lastFix: null,
  waiting: 0,
  dropped: 0,
  denied: false,
  closed: false,
  unknown: false,
  offline: false,
  searching: false,
  wakeLock: "off",
};

/**
 * Shares the phone's location for one link: watches the position while sharing, queues the points and sends them in
 * batches (lib/gps SendQueue), keeps the screen on where the browser can. Nothing runs until `start`.
 */
export function useLocationShare(token: string) {
  const [state, setState] = useState<ShareState>(IDLE);
  const queue = useRef<SendQueue | null>(null);
  const watch = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lock = useRef<WakeLockSentinel | null>(null);
  const sharing = useRef(false);

  const queueOf = useCallback(() => (queue.current ??= new SendQueue()), []);
  const patch = useCallback(
    (next: Partial<ShareState>) => setState((current) => ({ ...current, waiting: queueOf().size, dropped: queueOf().dropped, ...next })),
    [queueOf],
  );

  const keepScreenOn = useCallback(async () => {
    if (!("wakeLock" in navigator) || !navigator.wakeLock) {
      patch({ wakeLock: "none" });
      return;
    }
    try {
      lock.current = await navigator.wakeLock.request("screen");
      lock.current.addEventListener("release", () => {
        lock.current = null;
        if (sharing.current) patch({ wakeLock: "off" });
      });
      patch({ wakeLock: "on" });
    } catch {
      patch({ wakeLock: "off" });
    }
  }, [patch]);

  const halt = useCallback(() => {
    sharing.current = false;
    if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current);
    watch.current = null;
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    void lock.current?.release().catch(() => {});
    lock.current = null;
  }, []);

  const flush = useCallback(
    async (force = false) => {
      const waiting = queueOf();
      const now = Date.now();
      if (!force && !waiting.due(now)) return;
      if (waiting.sending || waiting.size === 0) return;
      const batch = waiting.take(now);
      try {
        await api.request(`/api/gps/share/${encodeURIComponent(token)}/positions`, { method: "POST", body: { points: batch }, auth: false });
        waiting.done(Date.now());
        patch({ lastSentAt: waiting.lastSentAt, offline: false });
      } catch (error) {
        if (isApiError(error) && error.status === 409) {
          halt();
          waiting.clear();
          patch({ sharing: false, closed: true });
        } else if (isApiError(error) && error.status === 404) {
          halt();
          waiting.clear();
          patch({ sharing: false, unknown: true });
        } else {
          waiting.failed(Date.now());
          patch({ offline: true });
        }
      }
    },
    [token, halt, patch, queueOf],
  );

  const start = useCallback(() => {
    if (sharing.current || !navigator.geolocation) return;
    sharing.current = true;
    patch({ sharing: true, startedAt: Date.now(), denied: false, searching: true, offline: false });
    watch.current = navigator.geolocation.watchPosition(
      (position) => {
        const point = pointFromPosition(position);
        queueOf().add(point);
        patch({ lastFix: { at: position.timestamp, accuracyM: point.accuracyM ?? null }, searching: false });
        void flush();
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          halt();
          patch({ sharing: false, denied: true, searching: false });
        } else {
          // no fix for now (indoors, a tunnel): keep watching
          patch({ searching: true });
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 },
    );
    timer.current = setInterval(() => void flush(), CHECK_MS);
    void keepScreenOn();
  }, [flush, halt, keepScreenOn, patch, queueOf]);

  const stop = useCallback(() => {
    halt();
    // what is still waiting goes once more; failing that it is dropped with the page
    void flush(true).finally(() => queueOf().clear());
    patch({ sharing: false, searching: false, wakeLock: "off" });
  }, [flush, halt, patch, queueOf]);

  // a refused permission is known before the button is pressed
  useEffect(() => {
    let status: PermissionStatus | null = null;
    const read = () => setState((current) => ({ ...current, denied: status?.state === "denied" ? true : current.sharing ? current.denied : false }));
    void navigator.permissions
      ?.query({ name: "geolocation" })
      .then((answer) => {
        status = answer;
        read();
        answer.addEventListener("change", read);
      })
      .catch(() => {});
    return () => status?.removeEventListener("change", read);
  }, []);

  // the browser drops the wake lock when the tab is hidden; take it again on return
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && sharing.current && !lock.current) void keepScreenOn();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [keepScreenOn]);

  useEffect(() => halt, [halt]);

  return { state, start, stop };
}
