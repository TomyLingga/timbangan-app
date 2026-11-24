"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { TruckModal } from "@/features/control-room/truck-modal";
import { ZoneList } from "@/features/control-room/zone-list";
import type { ControlRoomState } from "@/lib/control-room";
import { groupTrucksByZone } from "@/lib/control-room-map";

// The zone list and the truck detail window behind the plant map, the Zona panel and the map on Beranda: a zone's
// plate (or panel row) opens the list of its plates, a plate opens the detail window over the list. Closing the
// window gives the focus back to the plate row; closing the list gives it back to the zone.

export interface ZoneExplorer {
  openZone: string | null;
  /** Opens a zone's list at `anchor`; the same zone again closes it. */
  toggleZone: (code: string, anchor: HTMLElement) => void;
  closeZone: () => void;
  tripId: number | null;
  openTrip: (tripId: number, row: HTMLElement) => void;
  closeTrip: () => void;
  anchor: HTMLElement | null;
  returnFocus: () => HTMLElement | null;
}

export function useZoneExplorer(): ZoneExplorer {
  const [zone, setZone] = useState<{ code: string; anchor: HTMLElement } | null>(null);
  const [tripId, setTripId] = useState<number | null>(null);
  const row = useRef<HTMLElement | null>(null);

  const toggleZone = useCallback((code: string, anchor: HTMLElement) => {
    setZone((current) => (current?.code === code ? null : { code, anchor }));
  }, []);
  const closeZone = useCallback(() => setZone(null), []);
  const openTrip = useCallback((id: number, element: HTMLElement) => {
    row.current = element;
    setTripId(id);
  }, []);
  const closeTrip = useCallback(() => setTripId(null), []);
  const anchor = zone?.anchor ?? null;
  const returnFocus = useCallback(() => {
    if (row.current?.isConnected) return row.current;
    return anchor?.isConnected ? anchor : null;
  }, [anchor]);

  return { openZone: zone?.code ?? null, toggleZone, closeZone, tripId, openTrip, closeTrip, anchor, returnFocus };
}

export function ZoneExplorerLayer({ explorer, state, now }: { explorer: ZoneExplorer; state: ControlRoomState; now: Date }) {
  const groups = useMemo(() => groupTrucksByZone(state.zones, state.trucks, now), [state.zones, state.trucks, now]);
  const group = explorer.openZone ? groups.find((item) => item.code === explorer.openZone) ?? null : null;
  const live = explorer.tripId === null ? null : state.trucks.find((truck) => truck.tripId === explorer.tripId) ?? null;
  const liveZone = live ? groups.find((item) => item.code === live.zone) ?? null : null;

  return (
    <>
      {group && explorer.anchor ? (
        <ZoneList key={group.code} group={group} anchor={explorer.anchor} suspended={explorer.tripId !== null} onClose={explorer.closeZone} onTrip={explorer.openTrip} />
      ) : null}
      <TruckModal tripId={explorer.tripId} live={live} zoneName={liveZone?.name ?? null} now={now} onClose={explorer.closeTrip} returnFocus={explorer.returnFocus} />
    </>
  );
}
