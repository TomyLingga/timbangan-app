// GPS positions of trucks outside the plant (apps/api src/gps, docs/fase-8-gps.md): the shapes the routes answer,
// what a truck's last point says about it, the wording of the tracking page, and the send queue of the driver's page.

import { checkLocation, type LatLon } from "@/lib/location";
import type { Direction, PartnerRef } from "@/lib/types";

// --- shapes of apps/api src/gps/read-routes.ts and master-routes.ts --------------------------------------------------

export type PositionSource = "DEVICE" | "PHONE";

export interface GpsPoint {
  at: string;
  lat: number;
  lon: number;
  speedKph: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
  sourceKind: PositionSource | string;
}

/** A pinned destination of the trip's delivery order; distanceKm from the truck's last point, null without one. */
export interface TripDestination {
  deliveryOrderId: string | number;
  doNo: string;
  name: string | null;
  regency: string | null;
  lat: number;
  lon: number;
  distanceKm?: number | null;
}

export interface GpsTrip {
  id: string | number;
  tripNo: string | null;
  spjNo: string | null;
  direction: Direction | string | null;
  status: string | null;
  partner: PartnerRef;
  doNos: string[];
  contractNos: string[];
  /** One entry per pinned DO in allocation order; absent from an API before migration 0013. */
  destinations?: TripDestination[];
}

/** One row of GET /api/gps/vehicles. */
export interface GpsVehicleItem {
  vehicle: {
    id: string | number;
    plateNo: string;
    plateDisplay: string;
    vehicleType: { code: string; name: string } | null;
    owner: PartnerRef | null;
  };
  last: GpsPoint;
  minutesSince: number;
  trip: GpsTrip | null;
  distanceToPlantKm: number | null;
}

export interface GpsVehicleList {
  items: GpsVehicleItem[];
  total: number;
}

export interface TrackPoint extends GpsPoint {
  tripId: string | number | null;
}

/** GET /api/gps/vehicles/:id/track and /api/gps/trips/:tripId/track. */
export interface GpsTrack {
  points: TrackPoint[];
  total: number;
  thinned: boolean;
  trip?: { id: string | number; tripNo: string | null; plateDisplay: string | null; direction: string; status: string; destinations?: TripDestination[] };
  vehicle?: { id: string | number; plateDisplay: string };
}

export type GpsSourceKind = "PROVIDER" | "DEVICE";

export interface GpsSource {
  id: string | number;
  name: string;
  kind: GpsSourceKind;
  isActive: boolean;
  hasKey: boolean;
  keyCreatedAt: string | null;
  lastSeenAt: string | null;
  trackers: number;
}

export interface GpsTracker {
  id: string | number;
  vehicle: { id: string | number; plateDisplay: string };
  source: { id: string | number; name: string };
  deviceId: string;
  isActive: boolean;
  attachedAt: string;
  detachedAt: string | null;
}

export interface UnknownDevice {
  deviceId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastPointAt: string;
  pointCount: number;
}

export interface GpsSettings {
  plantLocation: { lat: number; lon: number } | null;
  retentionDays: number;
  customerDaysAfterExit: number;
}

/** GET /api/gps/share/:token, the driver's page. */
export interface ShareLink {
  plateDisplay: string | null;
  open: boolean;
  until: string;
  untilAt: string | null;
  /** The pinned destinations, without a distance; empty once sharing is closed. */
  destinations?: TripDestination[];
}

// --- what the last point says --------------------------------------------------------------------------------------

export type TruckState = "MOVING" | "STOPPED" | "SILENT";

/** A last point older than this says nothing about the truck now. */
export const SILENT_AFTER_MINUTES = 15;
/** GPS speed wanders a little around zero; above this the truck moves. */
export const MOVING_ABOVE_KPH = 3;

export function truckState(last: { at: string; speedKph: number | null }, now: number): TruckState {
  const at = Date.parse(last.at);
  if (!Number.isFinite(at) || now - at > SILENT_AFTER_MINUTES * 60_000) return "SILENT";
  return last.speedKph !== null && last.speedKph > MOVING_ABOVE_KPH ? "MOVING" : "STOPPED";
}

export const STATE_LABELS: Readonly<Record<TruckState, string>> = {
  MOVING: "Bergerak",
  STOPPED: "Berhenti",
  SILENT: "Tidak ada kabar",
};

export type StateFilter = "" | "bergerak" | "berhenti" | "tanpa-kabar";

const FILTER_OF: Readonly<Record<TruckState, Exclude<StateFilter, "">>> = { MOVING: "bergerak", STOPPED: "berhenti", SILENT: "tanpa-kabar" };

export const STATE_FILTERS: ReadonlyArray<{ value: StateFilter; label: string }> = [
  { value: "", label: "Semua" },
  { value: "bergerak", label: STATE_LABELS.MOVING },
  { value: "berhenti", label: STATE_LABELS.STOPPED },
  { value: "tanpa-kabar", label: STATE_LABELS.SILENT },
];

export function parseStateFilter(value: string | null): StateFilter {
  return STATE_FILTERS.some((filter) => filter.value === value) ? (value as StateFilter) : "";
}

export function filterByState(items: readonly GpsVehicleItem[], filter: StateFilter, now: number): GpsVehicleItem[] {
  return filter === "" ? [...items] : items.filter((row) => FILTER_OF[truckState(row.last, now)] === filter);
}

export function stateCounts(items: readonly GpsVehicleItem[], now: number): Record<StateFilter, number> {
  const counts: Record<StateFilter, number> = { "": items.length, bergerak: 0, berhenti: 0, "tanpa-kabar": 0 };
  for (const row of items) counts[FILTER_OF[truckState(row.last, now)]] += 1;
  return counts;
}

// --- wording -------------------------------------------------------------------------------------------------------

const decimal = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

/** "baru saja", "12 menit lalu", "3 jam lalu", "2 hari lalu". */
export function agoText(at: string, now: number): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "-";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

/** "840 m", "4,3 km", "123 km"; null when the plant's location is not set. */
export function distanceText(km: number | null): string | null {
  if (km === null || !Number.isFinite(km)) return null;
  if (km < 1) return `${Math.round((km * 1000) / 10) * 10} m`;
  if (km < 10) return `${decimal.format(km)} km`;
  return `${whole.format(km)} km`;
}

export function speedText(kph: number | null): string {
  return kph === null || !Number.isFinite(kph) ? "-" : `${whole.format(kph)} km/jam`;
}

export function accuracyText(metres: number | null): string {
  if (metres === null || !Number.isFinite(metres)) return "-";
  return metres < 1000 ? `± ${whole.format(metres)} m` : `± ${decimal.format(metres / 1000)} km`;
}

export const SOURCE_LABELS: Readonly<Record<PositionSource, string>> = { DEVICE: "Alat pelacak", PHONE: "Ponsel supir" };

export const sourceText = (kind: string) => SOURCE_LABELS[kind as PositionSource] ?? kind;

export const directionText = (direction: string | null | undefined) => (direction === "IN" ? "Incoming" : direction === "OUT" ? "Outgoing" : "-");

/** "TRIP-1 · Incoming · PT Contoh", the trip in one short line. */
export function tripLine(trip: GpsTrip): string {
  return [trip.tripNo ?? trip.spjNo ?? "Belum check-in", directionText(trip.direction), trip.partner?.name].filter(Boolean).join(" · ");
}

/** "Gudang Contoh, Kab. Contoh": a destination in one short line. */
export function destinationText(destination: Pick<TripDestination, "name" | "regency" | "doNo">): string {
  return [destination.name, destination.regency].filter((part) => part && part.trim()).join(", ") || destination.doNo;
}

/**
 * The points the map view fits when a truck is selected: the truck, its track and its destinations. Empty parts are
 * left out; the truck comes first, so a single point is the truck itself.
 */
export function fitPoints(truck: LatLon | null, track: readonly LatLon[] | null, destinations: readonly LatLon[] | null): [number, number][] {
  const points: LatLon[] = [...(truck ? [truck] : []), ...(track ?? []), ...(destinations ?? [])];
  return points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)).map((point) => [point.lat, point.lon]);
}

// --- the track of a selected truck ---------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The current trip's track when the truck is on a trip, otherwise the vehicle's last 24 hours. */
export function trackRequest(row: GpsVehicleItem, now: number): { path: string; query: Record<string, string>; label: string } {
  if (row.trip) {
    return {
      path: `/api/gps/trips/${encodeURIComponent(String(row.trip.id))}/track`,
      query: {},
      label: `Jejak perjalanan ${row.trip.tripNo ?? row.trip.spjNo ?? ""}`.trim(),
    };
  }
  return {
    path: `/api/gps/vehicles/${encodeURIComponent(String(row.vehicle.id))}/track`,
    query: { from: new Date(now - DAY_MS).toISOString(), to: new Date(now).toISOString() },
    label: "Jejak 24 jam terakhir",
  };
}

// --- the selection kept in the address bar -------------------------------------------------------------------------

export interface MapSelection {
  vehicle: string | null;
  trip: string | null;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const idOrNull = (value: string | null) => (value && ID.test(value) ? value : null);

export function parseSelection(search: string | URLSearchParams): MapSelection {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return { vehicle: idOrNull(params.get("vehicle")), trip: idOrNull(params.get("trip")) };
}

/** The query string with the selection written in, every other parameter kept. */
export function selectionSearch(search: string, selection: MapSelection): string {
  const params = new URLSearchParams(search);
  params.delete("vehicle");
  params.delete("trip");
  if (selection.vehicle) params.set("vehicle", selection.vehicle);
  if (selection.trip) params.set("trip", selection.trip);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The truck the selection names: by its trip first (a link from a trip row), then by the vehicle. */
export function findSelected(items: readonly GpsVehicleItem[], selection: MapSelection): GpsVehicleItem | null {
  if (selection.trip) return items.find((row) => row.trip !== null && String(row.trip.id) === selection.trip) ?? null;
  if (selection.vehicle) return items.find((row) => String(row.vehicle.id) === selection.vehicle) ?? null;
  return null;
}

const ON_THE_ROAD_OR_LATER = ["ISSUED", "CHECKED_IN", "IN_PROCESS", "COMPLETED", "REJECTED"];

/** The tracking page of a trip from its SPJ on; null before the SPJ or for a trip that never ran. */
export function positionLink(trip: { id: string | number; status: string }): string | null {
  return ON_THE_ROAD_OR_LATER.includes(trip.status.toUpperCase()) ? `/lacak?trip=${encodeURIComponent(String(trip.id))}` : null;
}

// --- the driver's page ---------------------------------------------------------------------------------------------

/** A point as POST /api/gps/share/:token/positions takes it. */
export interface SharePoint {
  at: string;
  lat: number;
  lon: number;
  speedKph?: number;
  headingDeg?: number;
  accuracyM?: number;
}

/** The API takes at most this many points per request (MAX_PHONE_POINTS). */
export const MAX_SEND_POINTS = 60;

/**
 * Points waiting to be sent. A batch goes when 5 points are waiting or 15 seconds passed since the last attempt; the
 * first point goes at once, so the driver sees it arrive. One batch is out at a time. Without signal the points wait,
 * at most `max` of them; the oldest are dropped first.
 */
export class SendQueue {
  private readonly max: number;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private waiting: SharePoint[] = [];
  private inFlight: SharePoint[] | null = null;
  private lastAttemptAt: number | null = null;
  /** When the last batch was stored by the API. */
  lastSentAt: number | null = null;
  /** Points dropped because too many were waiting. */
  dropped = 0;

  constructor({ max = MAX_SEND_POINTS, batchSize = 5, intervalMs = 15_000 }: { max?: number; batchSize?: number; intervalMs?: number } = {}) {
    this.max = max;
    this.batchSize = batchSize;
    this.intervalMs = intervalMs;
  }

  get size(): number {
    return this.waiting.length;
  }

  get sending(): boolean {
    return this.inFlight !== null;
  }

  add(point: SharePoint): void {
    this.waiting.push(point);
    this.trim();
  }

  due(now: number): boolean {
    if (this.inFlight !== null || this.waiting.length === 0) return false;
    if (this.waiting.length >= this.batchSize || this.lastAttemptAt === null) return true;
    return now - this.lastAttemptAt >= this.intervalMs;
  }

  /** The next batch, oldest first; it stays out until `done` or `failed`. */
  take(now: number): SharePoint[] {
    const batch = this.waiting.slice(0, MAX_SEND_POINTS);
    this.waiting = this.waiting.slice(batch.length);
    this.inFlight = batch;
    this.lastAttemptAt = now;
    return batch;
  }

  done(now: number): void {
    this.inFlight = null;
    this.lastSentAt = now;
  }

  /** The batch did not arrive: it goes back in front of the newer points. */
  failed(now: number): void {
    if (this.inFlight) this.waiting = [...this.inFlight, ...this.waiting];
    this.inFlight = null;
    this.lastAttemptAt = now;
    this.trim();
  }

  clear(): void {
    this.waiting = [];
    this.inFlight = null;
    this.lastAttemptAt = null;
  }

  private trim(): void {
    const over = this.waiting.length - this.max;
    if (over > 0) {
      this.waiting = this.waiting.slice(over);
      this.dropped += over;
    }
  }
}

interface PositionLike {
  timestamp: number;
  coords: { latitude: number; longitude: number; accuracy: number | null; speed: number | null; heading: number | null };
}

const within = (value: number | null | undefined, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** A browser position as a point; fields the browser does not know, or the API would refuse, are left out. */
export function pointFromPosition(position: PositionLike): SharePoint {
  const { latitude, longitude, accuracy, speed, heading } = position.coords;
  const point: SharePoint = { at: new Date(position.timestamp).toISOString(), lat: latitude, lon: longitude };
  if (within(accuracy, 0, 100_000)) point.accuracyM = accuracy;
  const kph = typeof speed === "number" ? Math.round(speed * 3.6 * 10) / 10 : null;
  if (within(kph, 0, 400)) point.speedKph = kph;
  if (within(heading, 0, 360)) point.headingDeg = heading;
  return point;
}

export type ShareScreen = "loading" | "unknown" | "closed" | "error" | "insecure" | "unsupported" | "denied" | "ready" | "sharing";

/** Which screen the driver's page shows: the link decides first, then what the browser allows. */
export function shareScreen(input: {
  link: "loading" | "open" | "closed" | "unknown" | "error";
  secure: boolean;
  geolocation: boolean;
  denied: boolean;
  sharing: boolean;
}): ShareScreen {
  if (input.link !== "open") return input.link;
  if (!input.secure) return "insecure";
  if (!input.geolocation) return "unsupported";
  if (input.denied) return "denied";
  return input.sharing ? "sharing" : "ready";
}

// --- settings ------------------------------------------------------------------------------------------------------

export interface GpsSettingsValues {
  lat: string;
  lon: string;
  retentionDays: string;
  customerDaysAfterExit: string;
}

const wholeFrom = (text: string, min: number, max: number): number | null => {
  const value = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  return value !== null && value >= min && value <= max ? value : null;
};

/** Checks the settings form; the payload is the body of PUT /api/gps/settings. */
export function validateGpsSettings(values: GpsSettingsValues): {
  errors: Partial<Record<keyof GpsSettingsValues, string>>;
  payload: GpsSettings | null;
} {
  const pin = checkLocation({ lat: values.lat, lon: values.lon });
  const errors: Partial<Record<keyof GpsSettingsValues, string>> = { ...pin.errors };
  const plantLocation: GpsSettings["plantLocation"] = pin.location;
  const retentionDays = wholeFrom(values.retentionDays, 7, 730);
  if (retentionDays === null) errors.retentionDays = "Isi angka bulat dari 7 sampai 730.";
  const customerDaysAfterExit = wholeFrom(values.customerDaysAfterExit, 0, 30);
  if (customerDaysAfterExit === null) errors.customerDaysAfterExit = "Isi angka bulat dari 0 sampai 30.";
  if (Object.keys(errors).length > 0 || retentionDays === null || customerDaysAfterExit === null) return { errors, payload: null };
  return { errors, payload: { plantLocation, retentionDays, customerDaysAfterExit } };
}

/** What a tracker provider needs to send positions: the address, the key header and an example body. */
export function trackerExample(apiUrl: string): { url: string; header: string; body: string } {
  const body = {
    points: [{ deviceId: "ALAT-CONTOH-01", at: "2026-11-20T03:00:00Z", lat: -10.5, lon: 85.25, speedKph: 42.5, headingDeg: 90, accuracyM: 8 }],
  };
  return { url: `${apiUrl.replace(/\/+$/, "")}/api/gps/positions`, header: "X-Tracker-Key", body: JSON.stringify(body, null, 2) };
}
