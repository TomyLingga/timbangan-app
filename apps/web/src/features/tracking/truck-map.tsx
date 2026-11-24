"use client";

import { useEffect, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap, Marker } from "leaflet";

import { TruckPicture } from "@/features/control-room/truck-picture";
import { placeIcon } from "@/features/tracking/location-picker";
import { MapCanvas, OVERVIEW, type LeafletModule } from "@/features/tracking/map-canvas";
import { destinationText, fitPoints, STATE_LABELS, truckState, type GpsVehicleItem, type TrackPoint, type TripDestination, type TruckState } from "@/lib/gps";
import { cn } from "@/lib/utils";

// The small sign in the corner of a marker. The shape says the state, so it never rests on colour alone: an arrow
// (turned to the heading) for moving, two bars for stopped, a question mark for no news.
export const STATE_GLYPHS: Readonly<Record<TruckState, string>> = {
  MOVING: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false"><path d="M6 1 10.6 10.6 6 8.3 1.4 10.6Z"/></svg>',
  STOPPED:
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false"><rect x="2.4" y="2" width="2.7" height="8" rx=".6"/><rect x="6.9" y="2" width="2.7" height="8" rx=".6"/></svg>',
  SILENT:
    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4.2 4.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.2v.3"/><circle cx="6" cy="9.7" r=".45" fill="currentColor"/></svg>',
};

const ICON_SIZE: [number, number] = [104, 52];
/** The middle of the truck box sits on the position. */
const ICON_ANCHOR: [number, number] = [52, 15];

/** The inside of a marker: the truck picture, the state sign, the plate, and the state in words for screen readers. */
function markerBody(template: Element | null, row: GpsVehicleItem, state: TruckState): HTMLElement {
  const body = document.createElement("div");
  body.className = "gps-marker-body";
  const truck = document.createElement("span");
  truck.className = "gps-marker-truck";
  if (template) truck.append(template.cloneNode(true));
  const sign = document.createElement("span");
  sign.className = "gps-marker-state";
  sign.innerHTML = STATE_GLYPHS[state];
  if (state === "MOVING" && row.last.headingDeg !== null) sign.style.transform = `rotate(${Math.round(row.last.headingDeg)}deg)`;
  truck.append(sign);
  const plate = document.createElement("span");
  plate.className = "gps-marker-plate";
  plate.textContent = row.vehicle.plateDisplay;
  const words = document.createElement("span");
  words.className = "sr-only";
  words.textContent = `, ${STATE_LABELS[state]}`;
  body.append(truck, plate, words);
  return body;
}

interface Layers {
  map: LeafletMap;
  L: LeafletModule;
  markers: Map<string, Marker>;
  track: LayerGroup;
  places: LayerGroup;
}

/**
 * The trucks on a road map. Selecting a marker (click, or Enter on a focused marker) calls `onSelect`. The view
 * fits all trucks once, then the selected truck and its track whenever the selection changes; a refresh never
 * moves the view the user has panned to.
 */
export function TruckMap({
  items,
  now,
  selectedId,
  track,
  destinations = null,
  onSelect,
  className,
}: {
  items: readonly GpsVehicleItem[];
  now: number;
  selectedId: string | null;
  /** The selected truck's track; null while there is none to draw. */
  track: readonly TrackPoint[] | null;
  /** The pinned destinations of the selected truck's trip. */
  destinations?: readonly TripDestination[] | null;
  onSelect: (vehicleId: string) => void;
  className?: string;
}) {
  // the Leaflet objects live in a ref; `ready` runs the effects again once they exist
  const leaflet = useRef<Layers | null>(null);
  const [ready, setReady] = useState(false);
  const template = useRef<HTMLDivElement>(null);
  const select = useRef(onSelect);
  const lastFit = useRef<string | null>(null);

  useEffect(() => {
    select.current = onSelect;
  });

  // markers follow the list: added, moved, redrawn, removed
  useEffect(() => {
    const layers = leaflet.current;
    if (!ready || !layers) return;
    const { L, map, markers } = layers;
    const picture = template.current?.firstElementChild ?? null;
    const seen = new Set<string>();
    for (const row of items) {
      const id = String(row.vehicle.id);
      seen.add(id);
      const state = truckState(row.last, now);
      const selected = id === selectedId;
      let marker = markers.get(id);
      if (!marker) {
        marker = L.marker([row.last.lat, row.last.lon], {
          icon: L.divIcon({ className: "gps-marker", html: "", iconSize: ICON_SIZE, iconAnchor: ICON_ANCHOR }),
          keyboard: true,
          riseOnHover: true,
        }).addTo(map);
        marker.on("click", () => select.current(id));
        // a focused marker is a div with role=button: Enter and Space select it as a button would
        marker.on("keydown", (event) => {
          const key = (event as unknown as { originalEvent: KeyboardEvent }).originalEvent.key;
          if (key === "Enter" || key === " ") {
            (event as unknown as { originalEvent: KeyboardEvent }).originalEvent.preventDefault();
            select.current(id);
          }
        });
        markers.set(id, marker);
      } else {
        marker.setLatLng([row.last.lat, row.last.lon]);
      }
      marker.setZIndexOffset(selected ? 1000 : state === "SILENT" ? -100 : 0);
      const element = marker.getElement();
      if (element) {
        element.replaceChildren(markerBody(picture, row, state));
        element.dataset.state = state;
        element.dataset.selected = String(selected);
        element.dataset.vehicleId = id;
        element.title = `${row.vehicle.plateDisplay}, ${STATE_LABELS[state]}`;
        element.setAttribute("aria-pressed", String(selected));
      }
    }
    for (const [id, marker] of markers) {
      if (!seen.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
  }, [ready, items, now, selectedId]);

  // the selected truck's track: a light halo under the line, and a ring at its first point
  useEffect(() => {
    const layers = leaflet.current;
    if (!ready || !layers) return;
    const { L, track: group } = layers;
    group.clearLayers();
    if (!track || track.length === 0) return;
    const line = track.map((point) => [point.lat, point.lon] as [number, number]);
    L.polyline(line, { className: "gps-track-halo", weight: 7, opacity: 0.85, interactive: false }).addTo(group);
    L.polyline(line, { className: "gps-track", weight: 3.5, opacity: 0.95, interactive: false }).addTo(group);
    const first = line[0];
    if (first) L.circleMarker(first, { className: "gps-track-start", radius: 5, weight: 2.5, fillOpacity: 1, interactive: false }).addTo(group);
  }, [ready, track]);

  // where the selected truck is going: one pin per destination, its name as the tooltip
  useEffect(() => {
    const layers = leaflet.current;
    if (!ready || !layers) return;
    const { L, places: group } = layers;
    group.clearLayers();
    for (const place of destinations ?? []) {
      const title = `Tujuan ${destinationText(place)}`;
      const marker = L.marker([place.lat, place.lon], { icon: placeIcon(L, "destination"), keyboard: false, title, alt: title, zIndexOffset: 500 }).addTo(group);
      marker.bindTooltip(destinationText(place), { direction: "top", offset: [0, -30], className: "gps-destination-tip" });
      const element = marker.getElement();
      if (element) element.dataset.deliveryOrderId = String(place.deliveryOrderId);
    }
  }, [ready, destinations]);

  // the view: every truck at first, then the selected truck with its track and its destinations
  const selectedRow = selectedId ? (items.find((row) => String(row.vehicle.id) === selectedId) ?? null) : null;
  const placeCount = destinations?.length ?? 0;
  // a trip whose truck is not in the list can still bring its track
  const fitKey = selectedRow
    ? `truck|${selectedId}|${track ? "track" : "-"}|${placeCount}`
    : track && track.length > 0
      ? `track|${track.length > 0}|${placeCount}`
      : selectedId
        ? "none"
        : `all|${items.length > 0}`;
  useEffect(() => {
    const layers = leaflet.current;
    if (!ready || !layers || lastFit.current === fitKey) return;
    const { L, map } = layers;
    if (fitKey === "none") return;
    lastFit.current = fitKey;
    if (selectedRow) {
      const points = fitPoints(selectedRow.last, track, destinations);
      if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15 });
      else map.setView(points[0] as [number, number], Math.max(map.getZoom(), 14));
    } else if (track && track.length > 0) {
      map.fitBounds(L.latLngBounds(fitPoints(null, track, destinations)), { padding: [48, 48], maxZoom: 15 });
    } else if (items.length > 0) {
      map.fitBounds(L.latLngBounds(items.map((row) => [row.last.lat, row.last.lon] as [number, number])), { padding: [56, 56], maxZoom: 12 });
    } else {
      map.setView(OVERVIEW.center, OVERVIEW.zoom);
    }
  }, [ready, fitKey, selectedRow, track, destinations, items]);

  return (
    <div className={cn("relative", className)}>
      <MapCanvas
        label="Peta truk"
        className="h-full w-full"
        onReady={(map, L) => {
          leaflet.current = { map, L, markers: new Map(), track: L.layerGroup().addTo(map), places: L.layerGroup().addTo(map) };
          setReady(true);
        }}
      />
      {/* the truck picture of the control room, copied into every marker */}
      <div ref={template} hidden>
        <TruckPicture className="gps-truck" />
      </div>
    </div>
  );
}
