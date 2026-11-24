// The control room (/ruang-kontrol): the shapes GET /api/control-room/state and /trips/:id answer (apps/api
// src/control-room), and the small rules of the plant map: zone boxes, when a wait counts as long, and how waiting
// time is written. The truck pictures, counts and zone lists are in control-room-map.ts.

export type Direction = "IN" | "OUT";

export interface ControlRoomZone {
  code: string;
  name: string;
  kind: string;
  color: string | null;
  /** Polygon in fractions of the plan's width and height; null when the zone is not on the plan. */
  shape: number[][] | null;
}

export interface ControlRoomTruck {
  tripId: number;
  tripNo: string | null;
  plateNo: string | null;
  plateDisplay: string | null;
  direction: Direction;
  flowCode: string;
  zone: string;
  stepCode: string | null;
  stepName: string | null;
  stepStatus: "READY" | "IN_PROGRESS" | null;
  since: string;
  held: { type: string; since: string } | null;
}

export interface ZoneStat {
  zone: string;
  count: number;
  longest: { tripId: number; plateDisplay: string | null; minutes: number } | null;
}

export interface ControlRoomState {
  generatedAt: string;
  plantDay: string;
  /** The picture of the plan (GET /api/control-room/plan-image), null when none was imported. */
  planImage: { width: number; height: number; version: string } | null;
  zones: ControlRoomZone[];
  trucks: ControlRoomTruck[];
  upcoming: { in: number; out: number };
  kpi: { inside: number; upcoming: number; pendingDecisions: number; finishedToday: number; avgMinutesInPlantToday: number | null };
  zoneStats: ZoneStat[];
  recent: { at: string; tripId: number; plateDisplay: string | null; text: string }[];
}

export interface TripTimeline {
  trip: {
    id: number;
    tripNo: string | null;
    plateDisplay: string | null;
    direction: Direction;
    flowCode: string;
    status: string;
    checkedInAt: string | null;
    completedAt: string | null;
  };
  /** The truck's papers for the detail window. */
  truck: TruckPapers;
  steps: {
    code: string;
    name: string | null;
    status: string;
    result: string | null;
    readyAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    minutes: number | null;
  }[];
  weighings: { stage: number; kind: string; kg: number; at: string; mode: string; plateCheck: string; status: string }[];
  exceptions: { type: string; status: string; raisedAt: string; decidedAt: string | null; decisionCode: string | null }[];
}

export interface TruckFigures {
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
}

export interface TruckPapers {
  regNo: string;
  spjNo: string | null;
  driverName: string | null;
  transporterName: string | null;
  /** Supplier of an incoming truck, customer of an outgoing one. */
  partnerName: string;
  partnerRole: "SUPPLIER" | "CUSTOMER";
  vehicleType: string | null;
  containerNo: string | null;
  /** The number on the card the truck carries now. */
  cardLabel: string | null;
  products: string[];
  allocations: { contractNo: string; doNo: string | null }[];
  /** From the supplier's letter. */
  letter: TruckFigures;
  /** From the valid weighings. */
  weighed: TruckFigures;
}

/** A truck that has stood in one place this long gets a warning mark. */
export const LONG_WAIT_MINUTES = 60;

/** Short zone names for the panel, the markers' tooltips and the screen-reader summary. */
export const ZONE_SHORT_NAMES: Readonly<Record<string, string>> = {
  REG: "Pos registrasi",
  QUEUE: "Antrean timbang",
  WB: "Timbangan",
  QC: "QC",
  STAGING: "Parkir muat/bongkar",
  DOCK: "Loading dock",
  LOADING: "Loading",
  UNLOADING: "Unloading",
  SEAL: "Locis segel",
};

export const shortZoneName = (zone: Pick<ControlRoomZone, "code" | "name">) => ZONE_SHORT_NAMES[zone.code] ?? zone.name;

export const FLOW_LABELS: Readonly<Record<string, string>> = {
  IN_CPO: "Incoming CPO",
  IN_GOODS: "Incoming barang",
  OUT_BULK: "Outgoing curah",
  OUT_PACKED: "Outgoing kemasan",
};

/** What a held truck waits for. */
export const HELD_LABELS: Readonly<Record<string, string>> = {
  PLATE: "Menunggu keputusan plat",
  GROSS_IN: "Menunggu keputusan bruto",
  TARE_OUT: "Menunggu keputusan tarra",
  NET_IN: "Menunggu keputusan netto",
  NET_OUT: "Menunggu keputusan netto",
  QC_HOLD: "Ditahan QC",
};

export function minutesSince(since: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
}

export function isLongWait(since: string, now: Date, thresholdMinutes = LONG_WAIT_MINUTES): boolean {
  return minutesSince(since, now) >= thresholdMinutes;
}

const clockFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const clockSecondsFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/** Time of day at the plant, "10.15" or with seconds "10.15.32". */
export function formatClock(value: string | Date, withSeconds = false): string {
  return (withSeconds ? clockSecondsFormat : clockFormat).format(new Date(value)).replaceAll(":", ".");
}

/** "45 mnt", "1 j", "2 j 5 mnt". */
export function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} mnt`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} j` : `${hours} j ${rest} mnt`;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bounding box of a zone polygon, in the polygon's own units; null without at least three points. */
export function shapeBox(shape: number[][] | null): Box | null {
  if (!shape || shape.length < 3) return null;
  const xs = shape.map((point) => point[0] ?? 0);
  const ys = shape.map((point) => point[1] ?? 0);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export interface Point {
  x: number;
  y: number;
}

/** One sentence per zone for screen readers: "Pos registrasi 1 truk. Timbangan kosong." */
export function zoneSummary(zones: ControlRoomZone[], stats: ZoneStat[], inside: number): string {
  const counts = new Map(stats.map((stat) => [stat.zone, stat.count]));
  const parts = zones.map((zone) => {
    const count = counts.get(zone.code) ?? 0;
    return `${shortZoneName(zone)} ${count === 0 ? "kosong" : `${count} truk`}.`;
  });
  return [`Truk di dalam pabrik: ${inside}.`, ...parts].join(" ");
}

/** The number of trucks per zone, in plan order, with the zone's short name and colour (the row under the map). */
export function zoneCounts(zones: ControlRoomZone[], stats: ZoneStat[]): { code: string; name: string; color: string | null; count: number }[] {
  const counts = new Map(stats.map((stat) => [stat.zone, stat.count]));
  return zones.map((zone) => ({ code: zone.code, name: shortZoneName(zone), color: zone.color, count: counts.get(zone.code) ?? 0 }));
}
