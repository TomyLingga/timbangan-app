"use client";

import { useEffect, useState } from "react";

import { API_URL } from "@/lib/config";
import type { ControlRoomState } from "@/lib/control-room";
import { isPlanImageType, isSafePlanSvg, planAspect, planBackdrop, planImagePath, type PlanBackdrop, type PlanImageRef } from "@/lib/control-room-plan";
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
      getToken: (options) => api.getAccessToken({ renew: options?.refresh }),
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
  /** Checked SVG markup of the line drawing; null when the picture is shown, while loading, or after a failure. */
  markup: string | null;
  /** Object URL of the plan picture, when the site has one and it loaded. */
  imageUrl: string | null;
  /** What the map draws under the zones, and the box the zone fractions are laid over. */
  backdrop: PlanBackdrop;
  loaded: boolean;
}

const EMPTY: PlanDrawing = { markup: null, imageUrl: null, backdrop: planBackdrop(null, null), loaded: false };

/**
 * The plan behind the map: the picture when the state announces one (`image`), else the line drawing. Nothing is
 * asked for while `image` is undefined (the state has not arrived). The picture is fetched through the API client,
 * because the request needs the bearer header, and shown from an object URL.
 */
export function usePlanDrawing(image: PlanImageRef | null | undefined): PlanDrawing {
  const [drawing, setDrawing] = useState<PlanDrawing>(EMPTY);
  const waiting = image === undefined;
  const version = image?.version ?? null;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;

  useEffect(() => {
    if (waiting) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const signal = controller.signal;

    const loadSvg = () =>
      api
        .download("/api/control-room/plan.svg", { signal })
        .then(async ({ blob }) => {
          const text = await blob.text();
          const safe = isSafePlanSvg(text);
          if (signal.aborted) return;
          const aspect = safe ? planAspect(text) : null;
          setDrawing({ markup: safe ? text : null, imageUrl: null, backdrop: planBackdrop(null, aspect), loaded: true });
        })
        .catch(() => {
          if (!signal.aborted) setDrawing({ ...EMPTY, loaded: true });
        });

    if (version !== null) {
      api
        .download(planImagePath(version), { signal })
        .then(({ blob }) => {
          if (signal.aborted) return;
          if (!isPlanImageType(blob.type)) return loadSvg();
          objectUrl = URL.createObjectURL(blob);
          setDrawing({ markup: null, imageUrl: objectUrl, backdrop: planBackdrop({ width, height, version }, null), loaded: true });
        })
        .catch(() => {
          // without the picture the line drawing still shows where the zones are
          if (!signal.aborted) void loadSvg();
        });
    } else {
      void loadSvg();
    }
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [waiting, version, width, height]);

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
