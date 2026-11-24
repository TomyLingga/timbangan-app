"use client";

import "leaflet/dist/leaflet.css";
import "./tracking.css";

import { useEffect, useEffectEvent, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";

import { MAP_ATTRIBUTION, MAP_TILES_URL } from "@/lib/config";
import { cn } from "@/lib/utils";

export type LeafletModule = typeof import("leaflet");

/** The whole country, for a map with nothing on it yet. */
export const OVERVIEW = { center: [-2.5, 118] as [number, number], zoom: 5 };

/**
 * A Leaflet road map. Leaflet touches `window` when it loads, so it is loaded in the browser only, after the first
 * render. `onReady` gets the map once it exists; the map is removed when the component goes.
 */
export function MapCanvas({
  label,
  className,
  onReady,
}: {
  /** Accessible name of the map region. */
  label: string;
  className?: string;
  onReady: (map: LeafletMap, L: LeafletModule) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ready = useEffectEvent(onReady);

  useEffect(() => {
    let map: LeafletMap | null = null;
    let observer: ResizeObserver | null = null;
    let cancelled = false;
    void import("leaflet").then((module) => {
      const L = (module as unknown as { default?: LeafletModule }).default ?? module;
      const element = container.current;
      if (cancelled || !element) return;
      map = L.map(element, { center: OVERVIEW.center, zoom: OVERVIEW.zoom, worldCopyJump: true, zoomSnap: 0.5 });
      L.tileLayer(MAP_TILES_URL, { attribution: MAP_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      // the box grows and shrinks with the page (phone rotation, sidebar)
      observer = new ResizeObserver(() => map?.invalidateSize());
      observer.observe(element);
      ready(map, L);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      map?.remove();
    };
  }, []);

  return <div ref={container} role="region" aria-label={label} className={cn("gps-map relative z-0", className)} />;
}
