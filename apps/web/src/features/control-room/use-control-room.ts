"use client";

import { useEffect, useState } from "react";

import { API_URL } from "@/lib/config";
import type { ControlRoomState } from "@/lib/control-room";
import { isSafePlanSvg, planAspect } from "@/lib/control-room-plan";
import { currentAccessToken } from "@/lib/control-room-session";
import { type FeedStatus, startLiveFeed } from "@/lib/control-room-stream";
import { api } from "@/lib/session";

export interface LiveControlRoom {
  state: ControlRoomState | null;
  status: FeedStatus;
  /** When the last state arrived in this browser. */
  receivedAt: Date | null;
  /** The first load failed and nothing is shown yet. */
  error: unknown;
}

/** The state of the control room: one request at once, then the event stream (or polling when that fails). */
export function useLiveControlRoom(): LiveControlRoom {
  const [state, setState] = useState<ControlRoomState | null>(null);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [receivedAt, setReceivedAt] = useState<Date | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    const take = (next: ControlRoomState) => {
      if (!active) return;
      setState(next);
      setReceivedAt(new Date());
      setError(null);
    };
    const poll = () => api.request<ControlRoomState>("/api/control-room/state");
    poll().then(take, (reason: unknown) => {
      if (active) setError(reason);
    });
    const feed = startLiveFeed<ControlRoomState>({
      streamUrl: `${API_URL}/api/control-room/stream`,
      getToken: (options) => currentAccessToken(api, options),
      poll,
      onState: take,
      onStatus: (next) => {
        if (active) setStatus(next);
      },
    });
    return () => {
      active = false;
      feed.stop();
    };
  }, []);

  return { state, status, receivedAt, error };
}

export interface PlanDrawing {
  /** Checked SVG markup, or null while loading, after a failure, or when the drawing was refused. */
  markup: string | null;
  aspect: { width: number; height: number } | null;
  loaded: boolean;
}

/** The plan drawing behind the map. */
export function usePlanDrawing(): PlanDrawing {
  const [drawing, setDrawing] = useState<PlanDrawing>({ markup: null, aspect: null, loaded: false });

  useEffect(() => {
    const controller = new AbortController();
    api
      .download("/api/control-room/plan.svg", { signal: controller.signal })
      .then(async ({ blob }) => {
        const text = await blob.text();
        const safe = isSafePlanSvg(text);
        setDrawing({ markup: safe ? text : null, aspect: safe ? planAspect(text) : null, loaded: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setDrawing({ markup: null, aspect: null, loaded: true });
      });
    return () => controller.abort();
  }, []);

  return drawing;
}

/** The current time, moved every `ms` so waiting times on the map keep counting between updates. */
export function useNow(ms = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
