// Mock of the GPS part of the API (apps/api src/gps), for dev/mock-api.mjs. Every plate, name and number is made up,
// and every position lies in the open Indian Ocean, far from any coast, like the fixtures of apps/api.
//
// Three tracked trucks: ZZ 0003 CTH drives a scripted route towards the plant and back at about 45 km/h on the
// incoming trip of the first registration (a tracker sends a point every 15 seconds), ZZ 0002 CTH stands near the
// plant (a driver's phone), ZZ 0001 CTH went silent two hours ago. Positions follow the clock, so every request
// sees the trucks where they are now.
//
// Helpers the real API does not have:
//   GET  /__mock/tile/:id                 a blank map tile (`z-x-y.png`), for tests without the internet
//   GET  /__mock/gps-share-points         how many points the driver's page sent, per link
//   POST /__mock/gps-share/:id/close      closes sharing of a link, so the next send answers 409

import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

/** The made-up plant, in the open sea. */
export const PLANT = { lat: -10.5, lon: 85.25 };
const KM_LAT = 110.6;
const KM_LON = 109.4;
const at = (east, north) => ({ lat: PLANT.lat + north / KM_LAT, lon: PLANT.lon + east / KM_LON });

const MINUTE = 60_000;
const STEP_MS = 15_000;
const ON_THE_ROAD = ["ISSUED", "CHECKED_IN", "IN_PROCESS"];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

// --- the scripted route --------------------------------------------------------------------------------------------

const ROUTE = [at(-24, -9), at(-19, -6.5), at(-14, -6.8), at(-10, -3.5), at(-6, -2.6), at(-3, -1.2), at(-0.6, -0.3)];
const SPEED_KPH = 45;

const kmBetween = (a, b) => Math.hypot((b.lat - a.lat) * KM_LAT, (b.lon - a.lon) * KM_LON);
const LEGS = ROUTE.slice(1).map((point, index) => ({ from: ROUTE[index], to: point, km: kmBetween(ROUTE[index], point) }));
const ROUTE_KM = LEGS.reduce((sum, leg) => sum + leg.km, 0);
const bearing = (a, b) => (Math.atan2((b.lon - a.lon) * KM_LON, (b.lat - a.lat) * KM_LAT) * (180 / Math.PI) + 360) % 360;
const EPOCH = Date.now() - 22 * MINUTE;

/** Where the moving truck is at time `ms`: there and back along the route, forever. */
function routePoint(ms) {
  const travelled = ((ms - EPOCH) / 3_600_000) * SPEED_KPH;
  const round = ((travelled % (2 * ROUTE_KM)) + 2 * ROUTE_KM) % (2 * ROUTE_KM);
  const back = round > ROUTE_KM;
  let left = back ? 2 * ROUTE_KM - round : round;
  for (const leg of LEGS) {
    if (left <= leg.km || leg === LEGS.at(-1)) {
      const share = leg.km === 0 ? 0 : Math.min(left / leg.km, 1);
      const point = { lat: leg.from.lat + (leg.to.lat - leg.from.lat) * share, lon: leg.from.lon + (leg.to.lon - leg.from.lon) * share };
      return { ...point, headingDeg: Math.round(back ? bearing(leg.to, leg.from) : bearing(leg.from, leg.to)) };
    }
    left -= leg.km;
  }
  return { ...ROUTE[0], headingDeg: 90 };
}

const iso = (ms) => new Date(ms).toISOString();
const stepDown = (ms) => Math.floor(ms / STEP_MS) * STEP_MS;

/** The point of each made-up truck at `ms`, or null when it sent nothing then. */
const SCRIPTS = {
  // a tracker on the road
  moving: (ms) => {
    const point = routePoint(ms);
    const wobble = Math.sin(ms / 47_000) * 4;
    return { at: iso(ms), lat: point.lat, lon: point.lon, speedKph: Math.round((SPEED_KPH + wobble) * 10) / 10, headingDeg: point.headingDeg, accuracyM: 6, sourceKind: "DEVICE" };
  },
  // a phone: drove in from the north-east, stands near the plant since forty minutes ago
  standing: (ms, now) => {
    const arrived = now - 40 * MINUTE;
    const from = at(8, 5);
    const to = at(0.4, 0.25);
    const share = Math.min(Math.max((ms - (arrived - 25 * MINUTE)) / (25 * MINUTE), 0), 1);
    const moving = share < 1;
    return {
      at: iso(ms),
      lat: from.lat + (to.lat - from.lat) * share,
      lon: from.lon + (to.lon - from.lon) * share,
      speedKph: moving ? 32 : 0,
      headingDeg: moving ? Math.round(bearing(from, to)) : null,
      accuracyM: 18,
      sourceKind: "PHONE",
    };
  },
  // a tracker that stopped sending two hours ago
  silent: (ms) => {
    const share = Math.min(Math.max((ms - (EPOCH - 160 * MINUTE)) / (45 * MINUTE), 0), 1);
    const from = at(16, 11);
    const to = at(6, 4);
    return { at: iso(ms), lat: from.lat + (to.lat - from.lat) * share, lon: from.lon + (to.lon - from.lon) * share, speedKph: share < 1 ? 38 : 0, headingDeg: null, accuracyM: 9, sourceKind: "DEVICE" };
  },
};

/** When each truck's points end: the silent one stopped sending, the others send until now. */
const lastAt = (fleet, now) => (fleet.script === "silent" ? stepDown(EPOCH - 108 * MINUTE) : stepDown(now) - (fleet.script === "standing" ? 2 * MINUTE : 0));

// --- a blank tile ---------------------------------------------------------------------------------------------------

function encodePng(width, height, rgb) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A pale tile with a faint line on two edges, so the tile grid shows when the map moves. */
const TILE = (() => {
  const size = 256;
  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x === 0 || y === 0;
      const offset = (y * size + x) * 3;
      rgb[offset] = edge ? 214 : 228;
      rgb[offset + 1] = edge ? 222 : 234;
      rgb[offset + 2] = edge ? 228 : 238;
    }
  }
  return encodePng(size, size, rgb);
})();

// --- the mock --------------------------------------------------------------------------------------------------------

/**
 * The GPS routes over the mock's data. `deps` brings the mock's helpers and lists: guard, send, fail, invalid,
 * readJson, corsHeaders, plateKey, users, vehicles, trips, registrationOf, deliveryOrders, ref, webOrigin.
 */
export function createGpsMock(deps) {
  const { guard, send, fail, invalid, readJson, corsHeaders, plateKey, vehicles, trips, registrationOf, deliveryOrders, ref, webOrigin } = deps;
  const startedAt = Date.now();
  let nextSourceId = 2;
  let nextTrackerId = 3;

  const settings = { plantLocation: { ...PLANT }, retentionDays: 90, customerDaysAfterExit: 3 };
  const sources = [
    { id: "gs-1", name: "Penyedia Contoh", kind: "PROVIDER", isActive: true, keyHash: "x", keyCreatedAt: iso(startedAt - 3 * 86_400_000), lastSeenAt: "live" },
  ];
  const trackers = [
    { id: "gt-1", vehicleId: "v-3", sourceId: "gs-1", deviceId: "ALAT-0003", isActive: true, attachedAt: iso(startedAt - 3 * 86_400_000), detachedAt: null },
    { id: "gt-2", vehicleId: "v-1", sourceId: "gs-1", deviceId: "ALAT-0001", isActive: true, attachedAt: iso(startedAt - 2 * 86_400_000), detachedAt: null },
  ];
  const unknownDevices = new Map([
    ["gs-1", [{ deviceId: "ALAT-0099", firstSeenAt: iso(startedAt - 5 * 3_600_000), lastSeenAt: iso(startedAt - 4 * MINUTE), lastPointAt: iso(startedAt - 4 * MINUTE), pointCount: 12 }]],
  ]);

  // the trips the made-up trucks are on; found once the mock's own seed exists
  const firstTripOf = (test) => trips.find(test) ?? null;
  const fleet = [
    {
      vehicleId: "v-3",
      script: "moving",
      trip: firstTripOf((trip) => trip.vehicleId === "v-3" && trip.status === "ISSUED" && registrationOf(trip).direction === "IN"),
      tripStartMs: startedAt - 70 * MINUTE,
    },
    {
      vehicleId: "v-2",
      script: "standing",
      trip: firstTripOf((trip) => trip.vehicleId === "v-2" && registrationOf(trip).direction === "OUT"),
      tripStartMs: startedAt - 65 * MINUTE,
    },
    { vehicleId: "v-1", script: "silent", trip: null, tripStartMs: null },
  ];

  // share links of the driver's page: one per trip on the road, and two fixed ones for tests
  const shares = new Map();
  const sentPoints = new Map();
  const shareOf = (trip) => {
    for (const [token, share] of shares) if (share.tripId === trip.id) return token;
    const token = `contoh-${trip.id}`;
    shares.set(token, { tripId: trip.id, closed: false });
    return token;
  };
  shares.set("contoh-tutup", { tripId: null, closed: true, plateDisplay: "ZZ 0004 CTH" });
  // open whatever the seeded trips go through during a test run, until /__mock/gps-share/:id/close
  shares.set("contoh-buka", { tripId: null, closed: false, alwaysOpen: true, plateDisplay: "ZZ 0003 CTH" });
  shares.set("contoh-buka-2", { tripId: null, closed: false, alwaysOpen: true, plateDisplay: "ZZ 0003 CTH" });
  const isOpen = (share, trip) => !share.closed && (share.alwaysOpen === true || onTheRoad(trip));
  /** The link of a token; `contoh-<trip id>` exists for every trip, as if its SPJ had been printed. */
  const shareByToken = (token) => {
    if (!shares.has(token) && /^contoh-trip-\d+$/.test(token) && trips.some((trip) => trip.id === token.slice(7))) shares.set(token, { tripId: token.slice(7), closed: false });
    return shares.get(token) ?? null;
  };

  const vehicleOf = (id) => vehicles.find((item) => item.id === id) ?? null;
  const trackerOf = (vehicleId) => trackers.find((tracker) => tracker.vehicleId === vehicleId && tracker.isActive) ?? null;
  const sourceView = (source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    isActive: source.isActive,
    hasKey: source.keyHash !== null,
    keyCreatedAt: source.keyCreatedAt,
    lastSeenAt: source.lastSeenAt === "live" ? (source.isActive ? iso(stepDown(Date.now())) : null) : source.lastSeenAt,
    trackers: trackers.filter((tracker) => tracker.sourceId === source.id && tracker.isActive).length,
  });
  const trackerView = (tracker) => {
    const vehicle = vehicleOf(tracker.vehicleId);
    const source = sources.find((item) => item.id === tracker.sourceId);
    return {
      id: tracker.id,
      vehicle: { id: tracker.vehicleId, plateDisplay: vehicle?.plateDisplay ?? "-" },
      source: { id: tracker.sourceId, name: source?.name ?? "-" },
      deviceId: tracker.deviceId,
      isActive: tracker.isActive,
      attachedAt: tracker.attachedAt,
      detachedAt: tracker.detachedAt,
    };
  };
  const newKey = (id) => `gs${String(id).replace(/\D/g, "")}.${[...randomBytes(43)].map((byte) => LETTERS[byte % 64]).join("")}`;

  /** The partner a trip concerns: the supplier of an incoming registration, the customer of a DO. */
  function concerns(user, trip) {
    if (!trip || user.kind === "INTERNAL") return user.kind === "INTERNAL";
    const registration = registrationOf(trip);
    if (registration.direction === "IN") return registration.partner?.id === user.partner?.id;
    return registration.allocations.some((allocation) => deliveryOrders.find((order) => order.id === allocation.deliveryOrderId)?.partner?.id === user.partner?.id);
  }
  const onTheRoad = (trip) => trip !== null && ON_THE_ROAD.includes(trip.status);
  const owns = (user, vehicle) => user.kind === "INTERNAL" || (vehicle?.owner?.id !== undefined && vehicle.owner.id === user.partner?.id);
  const sees = (user, entry) => owns(user, vehicleOf(entry.vehicleId)) || (onTheRoad(entry.trip) && concerns(user, entry.trip));

  const tripView = (trip) => {
    if (!trip) return null;
    const registration = registrationOf(trip);
    const orders = registration.allocations.map((allocation) => deliveryOrders.find((order) => order.id === allocation.deliveryOrderId)).filter(Boolean);
    return {
      id: trip.id,
      tripNo: trip.tripNo,
      spjNo: trip.spj?.spjNo ?? null,
      direction: registration.direction,
      status: trip.status,
      partner: ref(registration.partner),
      doNos: orders.map((order) => order.doNo),
      contractNos: registration.direction === "IN" ? ["0125/CONTOH/CPO/XI/2026"] : [],
    };
  };

  const distanceKm = (point) =>
    settings.plantLocation ? Math.round(Math.hypot((point.lat - settings.plantLocation.lat) * KM_LAT, (point.lon - settings.plantLocation.lon) * KM_LON) * 10) / 10 : null;

  function itemOf(entry, now) {
    const vehicle = vehicleOf(entry.vehicleId);
    const last = SCRIPTS[entry.script](lastAt(entry, now), now);
    return {
      vehicle: {
        id: vehicle.id,
        plateNo: vehicle.plateNo,
        plateDisplay: vehicle.plateDisplay,
        vehicleType: vehicle.vehicleTypeCode ? { code: vehicle.vehicleTypeCode, name: { TANGKI: "Truk tangki", BAK: "Truk bak", KONTAINER: "Truk kontainer" }[vehicle.vehicleTypeCode] } : null,
        owner: ref(vehicle.owner),
      },
      last,
      minutesSince: Math.max(0, Math.floor((now - Date.parse(last.at)) / MINUTE)),
      trip: onTheRoad(entry.trip) ? tripView(entry.trip) : null,
      distanceToPlantKm: distanceKm(last),
    };
  }

  /** The points of a truck between two times, one every 30 seconds, never past its last point. */
  function pointsOf(entry, fromMs, toMs, now) {
    const end = Math.min(toMs, lastAt(entry, now));
    const start = Math.max(fromMs, now - 3 * 3_600_000);
    const points = [];
    for (let ms = Math.ceil(start / 30_000) * 30_000; ms <= end; ms += 30_000) points.push({ ...SCRIPTS[entry.script](ms, now), tripId: null });
    const last = SCRIPTS[entry.script](lastAt(entry, now), now);
    if (end === lastAt(entry, now) && (points.length === 0 || points.at(-1).at !== last.at)) points.push({ ...last, tripId: null });
    return points;
  }

  const sendTile = (request, response) => {
    response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600", ...corsHeaders(request) });
    response.end(TILE);
    return 200;
  };

  const editors = (request, response) => guard(request, response, [["gps", "EDIT"]], { staffOnly: true });

  const routes = {
    "GET /api/gps/vehicles": (request, response, url) => {
      const user = guard(request, response, [["gps", "VIEW"]]);
      if (!user) return 0;
      const now = Date.now();
      const q = plateKey(url.searchParams.get("q"));
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      const matches = fleet
        .filter((entry) => vehicleOf(entry.vehicleId) && sees(user, entry))
        .map((entry) => itemOf(entry, now))
        .filter((item) => !q || item.vehicle.plateNo.includes(q))
        .sort((a, b) => a.vehicle.plateNo.localeCompare(b.vehicle.plateNo));
      return send(request, response, 200, { items: matches.slice(offset, offset + limit), total: matches.length });
    },

    "GET /api/gps/vehicles/:id/track": (request, response, url, id) => {
      const user = guard(request, response, [["gps", "VIEW"]]);
      if (!user) return 0;
      const entry = fleet.find((item) => item.vehicleId === id);
      if (!entry || !sees(user, entry)) return fail(request, response, 404, "NOT_FOUND", "Kendaraan tidak ditemukan.");
      const now = Date.now();
      const to = url.searchParams.get("to") ? Date.parse(url.searchParams.get("to")) : now;
      const from = url.searchParams.get("from") ? Date.parse(url.searchParams.get("from")) : to - 86_400_000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return invalid(request, response, { from: "Waktu awal harus sebelum waktu akhir." });
      const points = pointsOf(entry, from, to, now);
      return send(request, response, 200, { vehicle: { id, plateDisplay: vehicleOf(id)?.plateDisplay }, from: iso(from), to: iso(to), points, total: points.length, thinned: false });
    },

    "GET /api/gps/trips/:id/track": (request, response, url, id) => {
      const user = guard(request, response, [["gps", "VIEW"]]);
      if (!user) return 0;
      const trip = trips.find((item) => item.id === id);
      const entry = fleet.find((item) => item.trip?.id === id) ?? null;
      const visible = trip && (user.kind === "INTERNAL" || (entry && sees(user, entry)) || (onTheRoad(trip) && concerns(user, trip)));
      if (!visible) return fail(request, response, 404, "NOT_FOUND", "Trip tidak ditemukan.");
      const now = Date.now();
      const points = entry ? pointsOf(entry, entry.tripStartMs, now, now).map((point) => ({ ...point, tripId: id })) : [];
      const registration = registrationOf(trip);
      return send(request, response, 200, {
        trip: { id, tripNo: trip.tripNo, plateDisplay: vehicleOf(trip.vehicleId)?.plateDisplay ?? null, direction: registration.direction, status: trip.status },
        points,
        total: points.length,
        thinned: false,
      });
    },

    "GET /api/gps/sources": (request, response) => {
      if (!editors(request, response)) return 0;
      const ordered = [...sources].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));
      return send(request, response, 200, { items: ordered.map(sourceView) });
    },

    "POST /api/gps/sources": async (request, response) => {
      if (!editors(request, response)) return 0;
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const fields = {};
      if (!name || name.length > 100) fields.name = "Nama wajib diisi.";
      if (!["PROVIDER", "DEVICE"].includes(body.kind)) fields.kind = "Jenis harus PROVIDER (penyedia, banyak alat) atau DEVICE (satu alat).";
      if (Object.keys(fields).length > 0) return invalid(request, response, fields);
      const source = { id: `gs-${nextSourceId++}`, name, kind: body.kind, isActive: true, keyHash: "x", keyCreatedAt: iso(Date.now()), lastSeenAt: null };
      sources.push(source);
      return send(request, response, 201, { source: sourceView(source), key: newKey(source.id) });
    },

    "POST /api/gps/sources/:id/key": (request, response, url, id) => {
      if (!editors(request, response)) return 0;
      const source = sources.find((item) => item.id === id);
      if (!source) return fail(request, response, 404, "NOT_FOUND", "Sumber GPS tidak ditemukan.");
      source.keyCreatedAt = iso(Date.now());
      return send(request, response, 200, { source: sourceView(source), key: newKey(source.id) });
    },

    "POST /api/gps/sources/:id/deactivate": (request, response, url, id) => {
      if (!editors(request, response)) return 0;
      const source = sources.find((item) => item.id === id);
      if (!source) return fail(request, response, 404, "NOT_FOUND", "Sumber GPS tidak ditemukan.");
      if (!source.isActive) return fail(request, response, 409, "INVALID_STATE", "Sumber GPS ini sudah tidak aktif.");
      source.isActive = false;
      return send(request, response, 200, { source: sourceView(source) });
    },

    "GET /api/gps/sources/:id/unknown-devices": (request, response, url, id) => {
      if (!editors(request, response)) return 0;
      if (!sources.some((item) => item.id === id)) return fail(request, response, 404, "NOT_FOUND", "Sumber GPS tidak ditemukan.");
      return send(request, response, 200, { items: unknownDevices.get(id) ?? [] });
    },

    "GET /api/gps/trackers": (request, response, url) => {
      if (!editors(request, response)) return 0;
      const sourceId = url.searchParams.get("sourceId");
      const vehicleId = url.searchParams.get("vehicleId");
      const rows = trackers
        .filter((tracker) => (!sourceId || tracker.sourceId === sourceId) && (!vehicleId || tracker.vehicleId === vehicleId))
        .sort((a, b) => Number(b.isActive) - Number(a.isActive) || plateKey(vehicleOf(a.vehicleId)?.plateDisplay).localeCompare(plateKey(vehicleOf(b.vehicleId)?.plateDisplay)));
      return send(request, response, 200, { items: rows.map(trackerView) });
    },

    "POST /api/gps/trackers": async (request, response) => {
      if (!editors(request, response)) return 0;
      const body = await readJson(request);
      const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
      const vehicle = vehicleOf(String(body.vehicleId));
      const source = sources.find((item) => item.id === String(body.sourceId));
      const fields = {};
      if (!vehicle) fields.vehicleId = "Kendaraan tidak ditemukan.";
      if (!source) fields.sourceId = "Sumber GPS tidak ditemukan.";
      else if (!source.isActive) fields.sourceId = "Sumber GPS ini sudah tidak aktif.";
      if (!deviceId || deviceId.length > 64) fields.deviceId = "Nomor alat wajib diisi.";
      if (Object.keys(fields).length > 0) return invalid(request, response, fields);
      if (trackerOf(vehicle.id)) return fail(request, response, 409, "DUPLICATE", `Kendaraan ${vehicle.plateDisplay} sudah memakai alat pelacak lain.`);
      const used = trackers.find((tracker) => tracker.isActive && tracker.sourceId === source.id && tracker.deviceId === deviceId);
      if (used) return fail(request, response, 409, "DUPLICATE", `Alat ${deviceId} sudah terpasang di kendaraan ${vehicleOf(used.vehicleId)?.plateDisplay}.`);
      const tracker = { id: `gt-${nextTrackerId++}`, vehicleId: vehicle.id, sourceId: source.id, deviceId, isActive: true, attachedAt: iso(Date.now()), detachedAt: null };
      trackers.push(tracker);
      unknownDevices.set(source.id, (unknownDevices.get(source.id) ?? []).filter((device) => device.deviceId !== deviceId));
      return send(request, response, 201, { tracker: trackerView(tracker) });
    },

    "POST /api/gps/trackers/:id/detach": (request, response, url, id) => {
      if (!editors(request, response)) return 0;
      const tracker = trackers.find((item) => item.id === id);
      if (!tracker) return fail(request, response, 404, "NOT_FOUND", "Alat pelacak tidak ditemukan.");
      if (!tracker.isActive) return fail(request, response, 409, "INVALID_STATE", "Alat pelacak ini sudah dilepas.");
      tracker.isActive = false;
      tracker.detachedAt = iso(Date.now());
      return send(request, response, 200, { tracker: trackerView(tracker) });
    },

    "GET /api/gps/settings": (request, response) => {
      if (!editors(request, response)) return 0;
      return send(request, response, 200, { settings });
    },

    "PUT /api/gps/settings": async (request, response) => {
      if (!editors(request, response)) return 0;
      const body = await readJson(request);
      const fields = {};
      const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
      if (body.retentionDays !== undefined && !whole(body.retentionDays, 7, 730)) fields.retentionDays = "Lama penyimpanan harus angka bulat dari 7 sampai 730 hari.";
      if (body.customerDaysAfterExit !== undefined && !whole(body.customerDaysAfterExit, 0, 30)) fields.customerDaysAfterExit = "Batas waktu customer harus angka bulat dari 0 sampai 30 hari.";
      if (body.plantLocation !== undefined && body.plantLocation !== null) {
        const { lat, lon } = body.plantLocation ?? {};
        if (typeof lat !== "number" || lat < -90 || lat > 90) fields["plantLocation.lat"] = "Lintang harus angka dari -90 sampai 90.";
        if (typeof lon !== "number" || lon < -180 || lon > 180) fields["plantLocation.lon"] = "Bujur harus angka dari -180 sampai 180.";
      }
      if (body.plantLocation === undefined && body.retentionDays === undefined && body.customerDaysAfterExit === undefined) fields[""] = "Kirim minimal satu pengaturan.";
      if (Object.keys(fields).length > 0) return invalid(request, response, fields);
      if (body.plantLocation !== undefined) settings.plantLocation = body.plantLocation === null ? null : { lat: body.plantLocation.lat, lon: body.plantLocation.lon };
      if (body.retentionDays !== undefined) settings.retentionDays = body.retentionDays;
      if (body.customerDaysAfterExit !== undefined) settings.customerDaysAfterExit = body.customerDaysAfterExit;
      return send(request, response, 200, { settings });
    },

    "GET /api/gps/share/:id": (request, response, url, id) => {
      const share = shareByToken(id);
      if (!share) return fail(request, response, 404, "NOT_FOUND", "Tautan berbagi lokasi tidak ditemukan.");
      const trip = share.tripId ? trips.find((item) => item.id === share.tripId) : null;
      const open = isOpen(share, trip);
      const plateDisplay = share.plateDisplay ?? vehicleOf(trip?.vehicleId)?.plateDisplay ?? null;
      const until = !open
        ? "Berbagi lokasi untuk perjalanan ini sudah ditutup."
        : trip && registrationOf(trip).direction === "OUT"
          ? `Sampai ${settings.customerDaysAfterExit} hari setelah truk keluar dari pabrik.`
          : "Sampai truk selesai dan keluar dari pabrik.";
      return send(request, response, 200, { plateDisplay, open, until, untilAt: null });
    },

    "POST /api/gps/share/:id/positions": async (request, response, url, id) => {
      const share = shareByToken(id);
      if (!share) return fail(request, response, 404, "NOT_FOUND", "Tautan berbagi lokasi tidak ditemukan.");
      const trip = share.tripId ? trips.find((item) => item.id === share.tripId) : null;
      if (!isOpen(share, trip)) return fail(request, response, 409, "SHARING_CLOSED", "Berbagi lokasi untuk perjalanan ini sudah ditutup.");
      const body = await readJson(request);
      const points = Array.isArray(body.points) ? body.points : null;
      if (!points || points.length === 0 || points.length > 60) return invalid(request, response, { points: "Kirim 1 sampai 60 titik." });
      const bad = points.findIndex((point) => typeof point?.lat !== "number" || typeof point?.lon !== "number" || Number.isNaN(Date.parse(point?.at)));
      if (bad !== -1) return invalid(request, response, { [`points.${bad}`]: "Titik tidak lengkap." });
      sentPoints.set(id, (sentPoints.get(id) ?? 0) + points.length);
      return send(request, response, 200, { stored: points.length, duplicates: 0, refused: 0, refusedBy: { range: 0, future: 0, tooOld: 0, jump: 0 } });
    },

    "GET /__mock/tile/:id": sendTile,
    "GET /__mock/gps-share-points": (request, response) => send(request, response, 200, Object.fromEntries(sentPoints)),
    "POST /__mock/gps-share/:id/close": (request, response, url, id) => {
      const share = shareByToken(id);
      if (!share) return fail(request, response, 404, "NOT_FOUND", "No such link");
      share.closed = true;
      return send(request, response, 204);
    },
  };

  return {
    routes,
    /** Whether the vehicle has an active tracker (GET /api/vehicles `hasGps`). */
    hasTracker: (vehicleId) => trackerOf(vehicleId) !== null,
    /** The driver's page of a trip on the road, as GET /api/trips/:id/spj carries it; null otherwise. */
    shareUrlFor: (trip) => (onTheRoad(trip) ? `${webOrigin}/bagi-lokasi/${shareOf(trip)}` : null),
  };
}
