"use client";

import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import type { DivIcon, Map as LeafletMap, Marker } from "leaflet";
import { Crosshair, MapPinX } from "lucide-react";

import { TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { MapCanvas, type LeafletModule } from "@/features/tracking/map-canvas";
import { checkLocation, coordinateText, parseCoordinatePair, type LatLon, type LocationText } from "@/lib/location";
import { cn } from "@/lib/utils";

/** What a pin stands for: the plant (a round "P") or a destination (a dark pin with a flag). */
export type PlaceKind = "plant" | "destination";

const FLAG =
  '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false"><path d="M3 1.2h1.2v9.6H3z"/><path d="M4.2 1.6h5.4L8.3 3.7l1.3 2.1H4.2z"/></svg>';

/** The Leaflet icon of a place. The destination's tip sits on the point; the plant's middle does. */
export function placeIcon(L: LeafletModule, kind: PlaceKind, title?: string): DivIcon {
  if (kind === "plant") {
    return L.divIcon({ className: "gps-plant", html: '<span class="gps-plant-pin" aria-hidden="true">P</span>', iconSize: [28, 28], iconAnchor: [14, 14] });
  }
  const label = title ? `<span class="sr-only">${title.replace(/[<>&"]/g, "")}</span>` : "";
  return L.divIcon({
    className: "gps-destination",
    html: `<span class="gps-destination-pin" aria-hidden="true"><span class="gps-destination-glyph">${FLAG}</span></span>${label}`,
    // the 26 px square turned 45 degrees has its sharp corner 13 * sqrt(2) below its middle
    iconSize: [30, 34],
    iconAnchor: [15, 31],
  });
}

/** The cross in the middle of the map: "Pakai titik tengah peta" takes the point under it. */
function Crosshairs() {
  return (
    <svg viewBox="0 0 28 28" className="gps-crosshair" aria-hidden="true" focusable="false">
      <path d="M14 2v8M14 18v8M2 14h8M18 14h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="14" cy="14" r="2" fill="currentColor" />
    </svg>
  );
}

/**
 * A pin typed or picked on a map: latitude and longitude fields, a map with a cross in the middle, "Pakai titik
 * tengah peta" and "Hapus pin". Pasting "lat, lon" (as Google Maps copies them) into either field fills both. The pin
 * is drawn while both fields hold a valid point; the map moves to it when it is outside the view.
 */
export function LocationPicker({
  value,
  errors,
  onChange,
  names,
  kind,
  mapLabel,
  hint,
  optional = true,
  className,
}: {
  value: LocationText;
  errors?: { lat?: string; lon?: string };
  onChange: (value: LocationText) => void;
  /** Form names of the two fields. */
  names: { lat: string; lon: string };
  kind: PlaceKind;
  /** Accessible name of the map. */
  mapLabel: string;
  /** What to do with the map, in one line. */
  hint: string;
  optional?: boolean;
  className?: string;
}) {
  const leaflet = useRef<{ map: LeafletMap; L: LeafletModule; pin: Marker | null } | null>(null);
  const [ready, setReady] = useState(false);
  const location = checkLocation(value).location;
  const pinLat = location?.lat ?? null;
  const pinLon = location?.lon ?? null;

  useEffect(() => {
    const held = leaflet.current;
    if (!ready || !held) return;
    held.pin?.remove();
    held.pin = null;
    if (pinLat === null || pinLon === null) return;
    held.pin = held.L.marker([pinLat, pinLon], { icon: placeIcon(held.L, kind), keyboard: false, interactive: false }).addTo(held.map);
    // a typed or pasted point may lie anywhere: bring it into view; a point taken from the middle already is
    if (!held.map.getBounds().contains([pinLat, pinLon])) held.map.setView([pinLat, pinLon], Math.max(held.map.getZoom(), 13));
  }, [ready, pinLat, pinLon, kind]);

  /** A pasted "lat, lon" fills both fields instead of landing whole in one. */
  function pasted(event: ClipboardEvent<HTMLInputElement>) {
    const pair = parseCoordinatePair(event.clipboardData.getData("text"));
    if (!pair) return;
    event.preventDefault();
    onChange({ lat: coordinateText(pair.lat), lon: coordinateText(pair.lon) });
  }

  const empty = value.lat.trim() === "" && value.lon.trim() === "";
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Lintang"
          name={names.lat}
          inputMode="decimal"
          value={value.lat}
          onChange={(lat) => onChange({ ...value, lat })}
          onPaste={pasted}
          error={errors?.lat}
          placeholder="-10.5"
          optional={optional}
        />
        <TextField
          label="Bujur"
          name={names.lon}
          inputMode="decimal"
          value={value.lon}
          onChange={(lon) => onChange({ ...value, lon })}
          onPaste={pasted}
          error={errors?.lon}
          placeholder="85.25"
          optional={optional}
        />
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">Bisa tempel lintang dan bujur sekaligus, misalnya -10.5, 85.25 dari Google Maps.</p>
      <div className="relative h-56 overflow-hidden rounded-xl border sm:h-64">
        <MapCanvas
          label={mapLabel}
          className="h-full w-full"
          onReady={(map, L) => {
            leaflet.current = { map, L, pin: null };
            setReady(true);
          }}
        />
        <Crosshairs />
      </div>
      {/* the picker sits in narrow places (a form sheet, half a settings page): hint above, buttons below */}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{hint}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!ready}
            onClick={() => {
              const center = leaflet.current?.map.getCenter();
              if (center) onChange({ lat: coordinateText(center.lat), lon: coordinateText(center.lng) });
            }}
          >
            <Crosshair aria-hidden="true" />
            Pakai titik tengah peta
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={empty} onClick={() => onChange({ lat: "", lon: "" })}>
            <MapPinX aria-hidden="true" />
            Hapus pin
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A small read-only map with one place on it, for a page that shows a saved pin. */
export function PlaceMap({ point, kind, label, title, className }: { point: LatLon; kind: PlaceKind; label: string; title?: string; className?: string }) {
  const leaflet = useRef<{ map: LeafletMap; L: LeafletModule; pin: Marker | null } | null>(null);
  const [ready, setReady] = useState(false);
  const { lat, lon } = point;

  useEffect(() => {
    const held = leaflet.current;
    if (!ready || !held) return;
    held.pin?.remove();
    held.pin = held.L.marker([lat, lon], { icon: placeIcon(held.L, kind, title), keyboard: false, interactive: false }).addTo(held.map);
    held.map.setView([lat, lon], 13);
  }, [ready, lat, lon, kind, title]);

  return (
    <div className={cn("relative overflow-hidden rounded-xl border", className)}>
      <MapCanvas
        label={label}
        className="h-full w-full"
        onReady={(map, L) => {
          leaflet.current = { map, L, pin: null };
          setReady(true);
        }}
      />
    </div>
  );
}
