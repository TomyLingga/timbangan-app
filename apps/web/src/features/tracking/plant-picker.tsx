"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import { Crosshair } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MapCanvas, type LeafletModule } from "@/features/tracking/map-canvas";

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * A small map for the plant's location: the saved point as a pin, a cross in the middle, and a button that takes
 * the middle of the map. Pan the map until the cross sits on the plant, then press the button.
 */
export function PlantPicker({
  location,
  onPick,
}: {
  location: { lat: number; lon: number } | null;
  onPick: (point: { lat: number; lon: number }) => void;
}) {
  const leaflet = useRef<{ map: LeafletMap; L: LeafletModule; pin: Marker | null } | null>(null);
  const [ready, setReady] = useState(false);
  const centred = useRef(false);

  useEffect(() => {
    const held = leaflet.current;
    if (!ready || !held) return;
    held.pin?.remove();
    held.pin = null;
    if (!location) return;
    const icon = held.L.divIcon({ className: "gps-plant", html: '<span class="gps-plant-pin" aria-hidden="true">P</span>', iconSize: [28, 28], iconAnchor: [14, 14] });
    held.pin = held.L.marker([location.lat, location.lon], { icon, keyboard: false, interactive: false }).addTo(held.map);
    if (!centred.current) {
      centred.current = true;
      held.map.setView([location.lat, location.lon], 13);
    }
  }, [ready, location]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-64 overflow-hidden rounded-xl border sm:h-72">
        <MapCanvas
          label="Peta lokasi pabrik"
          className="h-full w-full"
          onReady={(map, L) => {
            leaflet.current = { map, L, pin: null };
            setReady(true);
          }}
        />
        <svg viewBox="0 0 28 28" className="gps-crosshair" aria-hidden="true" focusable="false">
          <path d="M14 2v8M14 18v8M2 14h8M18 14h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="14" cy="14" r="2" fill="currentColor" />
        </svg>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Geser peta sampai tanda silang tepat di pabrik.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!ready}
          onClick={() => {
            const center = leaflet.current?.map.getCenter();
            if (center) onPick({ lat: round(center.lat), lon: round(center.lng) });
          }}
        >
          <Crosshair aria-hidden="true" />
          Pakai titik tengah peta
        </Button>
      </div>
    </div>
  );
}
