// The plant map with a truck picture and a count per zone (docs/fase-6-rancangan.md section 5): the trucks of each
// zone with their flags and order, the moves between two states for the travelling pictures, where the zone list
// opens inside the viewport, and how the pictures of neighbouring zones keep from covering each other.

import { type ControlRoomTruck, type ControlRoomZone, isLongWait, LONG_WAIT_MINUTES, minutesSince, type Point, shortZoneName } from "@/lib/control-room";

export interface ZoneTruckRow {
  truck: ControlRoomTruck;
  /** Minutes in this zone. */
  minutes: number;
  /** Has stood here past the long-wait limit. */
  long: boolean;
  /** Waits for a decision. */
  held: boolean;
}

export interface ZoneGroup {
  code: string;
  /** Short name (ZONE_SHORT_NAMES), or the zone's own name. */
  name: string;
  color: string | null;
  count: number;
  /** A truck here waits for a decision. */
  held: boolean;
  /** A truck here has stood past the long-wait limit. */
  longWait: boolean;
  /** Longest wait first. */
  trucks: ZoneTruckRow[];
  longest: ZoneTruckRow | null;
}

/**
 * The trucks of each zone, every zone of the plan in plan order (empty ones too), then any zone a truck stands in that
 * the plan does not list. Trucks are ordered by their wait in the zone, longest first; a tie goes by trip id.
 */
export function groupTrucksByZone(zones: ControlRoomZone[], trucks: ControlRoomTruck[], now: Date, longWaitMinutes = LONG_WAIT_MINUTES): ZoneGroup[] {
  const byZone = new Map<string, ControlRoomTruck[]>();
  for (const truck of trucks) {
    const list = byZone.get(truck.zone) ?? [];
    list.push(truck);
    byZone.set(truck.zone, list);
  }
  const known = new Set(zones.map((zone) => zone.code));
  const entries: { code: string; name: string; color: string | null }[] = [
    ...zones.map((zone) => ({ code: zone.code, name: shortZoneName(zone), color: zone.color })),
    ...[...byZone.keys()].filter((code) => !known.has(code)).map((code) => ({ code, name: code, color: null })),
  ];
  return entries.map((entry) => {
    const rows = (byZone.get(entry.code) ?? [])
      .map((truck) => ({ truck, minutes: minutesSince(truck.since, now), long: isLongWait(truck.since, now, longWaitMinutes), held: truck.held !== null }))
      .sort((a, b) => a.truck.since.localeCompare(b.truck.since) || a.truck.tripId - b.truck.tripId);
    return {
      ...entry,
      count: rows.length,
      held: rows.some((row) => row.held),
      longWait: rows.some((row) => row.long),
      trucks: rows,
      longest: rows[0] ?? null,
    };
  });
}

/** The accessible name of a zone on the map: "Timbangan, 3 truk, 1 menunggu keputusan". */
export function zoneLabel(group: ZoneGroup, longWaitMinutes = LONG_WAIT_MINUTES): string {
  if (group.count === 0) return `${group.name}, kosong`;
  const held = group.trucks.filter((row) => row.held).length;
  const long = group.trucks.filter((row) => row.long).length;
  return [
    `${group.name}, ${group.count} truk`,
    held > 0 ? `${held} menunggu keputusan` : null,
    long > 0 ? `${long} lebih dari ${longWaitMinutes} menit` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export interface Move {
  tripId: number;
  from: string;
  to: string;
}

/**
 * The trucks that stand in another zone than before, in the order of `after`, at most `limit` of them; `skipped`
 * counts the rest. Trucks that arrived or left are not moves.
 */
export function detectMoves(before: ControlRoomTruck[], after: ControlRoomTruck[], limit = 5): { moves: Move[]; skipped: number } {
  const zoneBefore = new Map(before.map((truck) => [truck.tripId, truck.zone]));
  const all: Move[] = [];
  for (const truck of after) {
    const from = zoneBefore.get(truck.tripId);
    if (from !== undefined && from !== truck.zone) all.push({ tripId: truck.tripId, from, to: truck.zone });
  }
  return { moves: all.slice(0, limit), skipped: Math.max(0, all.length - limit) };
}

/** Below this viewport width the zone list is a bottom sheet; from it on, a popover at the zone. */
export const SHEET_BELOW_PX = 640;

export const listMode = (viewportWidth: number): "sheet" | "popover" => (viewportWidth < SHEET_BELOW_PX ? "sheet" : "popover");

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a popover of `size` opens for an anchor (viewport pixels): below it when it fits, else above it when that
 * fits, else on the side with more room; centred on the anchor and kept `margin` inside the viewport.
 */
export function placePopover(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { gap = 8, margin = 12 } = {},
): { left: number; top: number; side: "top" | "bottom" } {
  const below = anchor.y + anchor.height + gap;
  const roomBelow = viewport.height - margin - below;
  const roomAbove = anchor.y - gap - margin;
  const side = roomBelow >= size.height || roomBelow >= roomAbove ? "bottom" : "top";
  const wantedTop = side === "bottom" ? below : anchor.y - gap - size.height;
  const top = Math.max(margin, Math.min(wantedTop, viewport.height - size.height - margin));
  const wantedLeft = anchor.x + anchor.width / 2 - size.width / 2;
  const left = Math.max(margin, Math.min(wantedLeft, viewport.width - size.width - margin));
  return { left, top, side };
}

/**
 * Centres of the zone pictures after pushing overlapping ones apart: each overlapping pair moves apart along the axis
 * where it overlaps least, both by half, until none overlap (or after a fixed number of rounds); every centre stays
 * far enough inside `bounds` for the whole picture to show.
 */
export function spreadBadges(
  items: { code: string; x: number; y: number }[],
  badge: { width: number; height: number },
  bounds: { width: number; height: number },
  gap = 4,
): Map<string, Point> {
  const points = items.map((item) => ({ code: item.code, x: item.x, y: item.y }));
  const clamp = (point: { x: number; y: number }) => {
    point.x = Math.min(Math.max(point.x, badge.width / 2), Math.max(badge.width / 2, bounds.width - badge.width / 2));
    point.y = Math.min(Math.max(point.y, badge.height / 2), Math.max(badge.height / 2, bounds.height - badge.height / 2));
  };
  points.forEach(clamp);
  const spanX = badge.width + gap;
  const spanY = badge.height + gap;
  for (let round = 0; round < 100; round++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!;
        const b = points[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = spanX - Math.abs(dx);
        const overlapY = spanY - Math.abs(dy);
        if (overlapX <= 1e-6 || overlapY <= 1e-6) continue;
        moved = true;
        if (overlapY <= overlapX) {
          const direction = dy > 0 || (dy === 0 && j > i) ? 1 : -1;
          a.y -= (direction * overlapY) / 2;
          b.y += (direction * overlapY) / 2;
        } else {
          const direction = dx > 0 || (dx === 0 && j > i) ? 1 : -1;
          a.x -= (direction * overlapX) / 2;
          b.x += (direction * overlapX) / 2;
        }
        clamp(a);
        clamp(b);
      }
    }
    if (!moved) break;
  }
  return new Map(points.map((point) => [point.code, { x: point.x, y: point.y }]));
}
