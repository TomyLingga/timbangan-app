import { describe, expect, it } from "vitest";

import {
  accuracyText,
  agoText,
  distanceText,
  filterByState,
  findSelected,
  parseSelection,
  parseStateFilter,
  pointFromPosition,
  positionLink,
  selectionSearch,
  SendQueue,
  shareScreen,
  speedText,
  stateCounts,
  trackerExample,
  trackRequest,
  truckState,
  validateGpsSettings,
  type GpsVehicleItem,
} from "@/lib/gps";

const NOW = Date.parse("2026-11-20T03:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function item(id: string, minutes: number, speedKph: number | null, trip: GpsVehicleItem["trip"] = null): GpsVehicleItem {
  return {
    vehicle: { id, plateNo: `ZZ${id}`, plateDisplay: `ZZ ${id}`, vehicleType: { code: "TANGKI", name: "Truk tangki" }, owner: null },
    last: { at: ago(minutes), lat: -10.5, lon: 85.25, speedKph, headingDeg: null, accuracyM: 8, sourceKind: "DEVICE" },
    minutesSince: minutes,
    trip,
    distanceToPlantKm: null,
  };
}

const TRIP = {
  id: 77,
  tripNo: "TRIP-CONTOH-1",
  spjNo: "SPJ-CONTOH-1",
  direction: "IN" as const,
  status: "ISSUED",
  partner: { id: 5, name: "PT Kebun Contoh" },
  doNos: [],
  contractNos: ["KTR-CONTOH-1"],
};

describe("truckState", () => {
  it("calls a fresh point above 3 km/h moving, and at or below it stopped", () => {
    expect(truckState({ at: ago(1), speedKph: 42 }, NOW)).toBe("MOVING");
    expect(truckState({ at: ago(1), speedKph: 3.1 }, NOW)).toBe("MOVING");
    expect(truckState({ at: ago(1), speedKph: 3 }, NOW)).toBe("STOPPED");
    expect(truckState({ at: ago(1), speedKph: 0 }, NOW)).toBe("STOPPED");
  });

  it("calls a point without speed stopped, since nothing says it moves", () => {
    expect(truckState({ at: ago(2), speedKph: null }, NOW)).toBe("STOPPED");
  });

  it("calls a last point older than 15 minutes silent, whatever its speed", () => {
    expect(truckState({ at: ago(15), speedKph: 60 }, NOW)).toBe("MOVING");
    expect(truckState({ at: ago(15.01), speedKph: 60 }, NOW)).toBe("SILENT");
    expect(truckState({ at: ago(600), speedKph: 0 }, NOW)).toBe("SILENT");
  });

  it("treats a point slightly ahead of the device clock as fresh", () => {
    expect(truckState({ at: ago(-2), speedKph: 20 }, NOW)).toBe("MOVING");
  });
});

describe("state filter", () => {
  const items = [item("1", 1, 40), item("2", 2, 0), item("3", 30, 50), item("4", 5, null)];

  it("reads the chip from the address bar and ignores anything else", () => {
    expect(parseStateFilter("bergerak")).toBe("bergerak");
    expect(parseStateFilter("berhenti")).toBe("berhenti");
    expect(parseStateFilter("tanpa-kabar")).toBe("tanpa-kabar");
    expect(parseStateFilter("")).toBe("");
    expect(parseStateFilter("MOVING")).toBe("");
    expect(parseStateFilter(null)).toBe("");
  });

  it("filters and counts by state", () => {
    expect(filterByState(items, "", NOW).map((row) => row.vehicle.id)).toEqual(["1", "2", "3", "4"]);
    expect(filterByState(items, "bergerak", NOW).map((row) => row.vehicle.id)).toEqual(["1"]);
    expect(filterByState(items, "berhenti", NOW).map((row) => row.vehicle.id)).toEqual(["2", "4"]);
    expect(filterByState(items, "tanpa-kabar", NOW).map((row) => row.vehicle.id)).toEqual(["3"]);
    expect(stateCounts(items, NOW)).toEqual({ "": 4, bergerak: 1, berhenti: 2, "tanpa-kabar": 1 });
  });
});

describe("wording", () => {
  it("says how long ago in minutes, hours and days", () => {
    expect(agoText(ago(0.2), NOW)).toBe("baru saja");
    expect(agoText(ago(-3), NOW)).toBe("baru saja");
    expect(agoText(ago(1), NOW)).toBe("1 menit lalu");
    expect(agoText(ago(59.9), NOW)).toBe("59 menit lalu");
    expect(agoText(ago(60), NOW)).toBe("1 jam lalu");
    expect(agoText(ago(125), NOW)).toBe("2 jam lalu");
    expect(agoText(ago(47 * 60), NOW)).toBe("47 jam lalu");
    expect(agoText(ago(48 * 60), NOW)).toBe("2 hari lalu");
    expect(agoText("bukan waktu", NOW)).toBe("-");
  });

  it("writes distance in metres below a kilometre, one decimal below ten, whole kilometres above", () => {
    expect(distanceText(null)).toBeNull();
    expect(distanceText(0)).toBe("0 m");
    expect(distanceText(0.84)).toBe("840 m");
    expect(distanceText(1)).toBe("1 km");
    expect(distanceText(4.25)).toBe("4,3 km");
    expect(distanceText(9.96)).toBe("10 km");
    expect(distanceText(123.4)).toBe("123 km");
    expect(distanceText(1234.4)).toBe("1.234 km");
  });

  it("writes speed and accuracy, or a dash when the point does not say", () => {
    expect(speedText(42.4)).toBe("42 km/jam");
    expect(speedText(0)).toBe("0 km/jam");
    expect(speedText(null)).toBe("-");
    expect(accuracyText(8.4)).toBe("± 8 m");
    expect(accuracyText(1500)).toBe("± 1,5 km");
    expect(accuracyText(null)).toBe("-");
  });
});

describe("track range", () => {
  it("takes the current trip's track when the truck is on a trip", () => {
    expect(trackRequest(item("9", 1, 10, TRIP), NOW)).toEqual({ path: "/api/gps/trips/77/track", query: {}, label: "Jejak perjalanan TRIP-CONTOH-1" });
  });

  it("takes the last 24 hours of the vehicle otherwise", () => {
    expect(trackRequest(item("9", 1, 10), NOW)).toEqual({
      path: "/api/gps/vehicles/9/track",
      query: { from: "2026-11-19T03:00:00.000Z", to: "2026-11-20T03:00:00.000Z" },
      label: "Jejak 24 jam terakhir",
    });
  });

  it("escapes the ids it puts in the path", () => {
    expect(trackRequest(item("v/1", 1, 10), NOW).path).toBe("/api/gps/vehicles/v%2F1/track");
  });
});

describe("selection in the address bar", () => {
  it("reads ?vehicle= and ?trip=, and refuses values that are not ids", () => {
    expect(parseSelection("?vehicle=12")).toEqual({ vehicle: "12", trip: null });
    expect(parseSelection(new URLSearchParams("trip=77&q=zz"))).toEqual({ vehicle: null, trip: "77" });
    expect(parseSelection("?vehicle=v-3&trip=5")).toEqual({ vehicle: "v-3", trip: "5" });
    expect(parseSelection("?vehicle=%3Cscript%3E&trip=")).toEqual({ vehicle: null, trip: null });
    expect(parseSelection("")).toEqual({ vehicle: null, trip: null });
  });

  it("writes the selection back and keeps the other parameters", () => {
    expect(selectionSearch("?q=zz&keadaan=bergerak", { vehicle: "12", trip: null })).toBe("?q=zz&keadaan=bergerak&vehicle=12");
    expect(selectionSearch("?q=zz&vehicle=12&trip=7", { vehicle: null, trip: null })).toBe("?q=zz");
    expect(selectionSearch("", { vehicle: "3", trip: "9" })).toBe("?vehicle=3&trip=9");
  });

  it("finds the chosen truck by its trip first, then by the vehicle", () => {
    const items = [item("1", 1, 0), item("2", 1, 0, TRIP)];
    expect(findSelected(items, { vehicle: null, trip: "77" })?.vehicle.id).toBe("2");
    expect(findSelected(items, { vehicle: "1", trip: null })?.vehicle.id).toBe("1");
    expect(findSelected(items, { vehicle: "1", trip: "77" })?.vehicle.id).toBe("2");
    expect(findSelected(items, { vehicle: null, trip: "78" })).toBeNull();
    expect(findSelected(items, { vehicle: null, trip: null })).toBeNull();
  });
});

describe("SendQueue", () => {
  const point = (second: number) => ({ at: new Date(NOW + second * 1000).toISOString(), lat: -10.5, lon: 85.25 + second / 10_000, accuracyM: 10 });

  it("sends the first point at once, then every 5 points or every 15 seconds", () => {
    const queue = new SendQueue();
    expect(queue.due(NOW)).toBe(false);
    queue.add(point(0));
    expect(queue.due(NOW)).toBe(true);
    expect(queue.take(NOW)).toEqual([point(0)]);
    queue.done(NOW);
    expect(queue.lastSentAt).toBe(NOW);

    for (let second = 1; second <= 4; second += 1) queue.add(point(second));
    expect(queue.due(NOW + 4000)).toBe(false);
    queue.add(point(5));
    expect(queue.due(NOW + 5000)).toBe(true);
    expect(queue.take(NOW + 5000)).toHaveLength(5);
    queue.done(NOW + 5000);

    queue.add(point(6));
    expect(queue.due(NOW + 19_999)).toBe(false);
    expect(queue.due(NOW + 20_000)).toBe(true);
  });

  it("sends one batch at a time; points that arrive meanwhile wait", () => {
    const queue = new SendQueue();
    queue.add(point(0));
    queue.take(NOW);
    for (let second = 1; second <= 6; second += 1) queue.add(point(second));
    expect(queue.sending).toBe(true);
    expect(queue.due(NOW + 60_000)).toBe(false);
    queue.done(NOW + 1000);
    expect(queue.size).toBe(6);
    expect(queue.due(NOW + 1000)).toBe(true);
  });

  it("keeps a failed batch in front of newer points and retries after the interval", () => {
    const queue = new SendQueue();
    queue.add(point(0));
    queue.add(point(1));
    const batch = queue.take(NOW);
    queue.add(point(2));
    queue.failed(NOW);
    expect(queue.size).toBe(3);
    expect(queue.due(NOW + 14_999)).toBe(false);
    expect(queue.due(NOW + 15_000)).toBe(true);
    expect(queue.take(NOW + 15_000)).toEqual([...batch, point(2)]);
  });

  it("keeps at most 60 points while the signal is gone, dropping the oldest", () => {
    const queue = new SendQueue();
    queue.add(point(0));
    queue.take(NOW);
    for (let second = 1; second <= 70; second += 1) queue.add(point(second));
    queue.failed(NOW);
    expect(queue.size).toBe(60);
    expect(queue.dropped).toBe(11);
    const batch = queue.take(NOW + 15_000);
    expect(batch).toHaveLength(60);
    expect(batch[0]).toEqual(point(11));
    expect(batch.at(-1)).toEqual(point(70));
  });

  it("sends at most 60 points in one request", () => {
    const queue = new SendQueue({ max: 100 });
    for (let second = 0; second < 80; second += 1) queue.add(point(second));
    expect(queue.take(NOW)).toHaveLength(60);
    expect(queue.size).toBe(20);
  });

  it("empties itself when sharing stops", () => {
    const queue = new SendQueue();
    queue.add(point(0));
    queue.take(NOW);
    queue.add(point(1));
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.sending).toBe(false);
    expect(queue.due(NOW + 60_000)).toBe(false);
  });
});

describe("pointFromPosition", () => {
  it("turns a browser position into a point the API takes", () => {
    const position = {
      timestamp: NOW,
      coords: { latitude: -10.5, longitude: 85.25, accuracy: 12.6, speed: 10, heading: 90.4, altitude: null, altitudeAccuracy: null },
    };
    expect(pointFromPosition(position)).toEqual({ at: "2026-11-20T03:00:00.000Z", lat: -10.5, lon: 85.25, accuracyM: 12.6, speedKph: 36, headingDeg: 90.4 });
  });

  it("leaves out what the browser does not know or the API would refuse", () => {
    const position = {
      timestamp: NOW,
      coords: { latitude: -10.5, longitude: 85.25, accuracy: 30, speed: null, heading: Number.NaN, altitude: null, altitudeAccuracy: null },
    };
    expect(pointFromPosition(position)).toEqual({ at: "2026-11-20T03:00:00.000Z", lat: -10.5, lon: 85.25, accuracyM: 30 });
    const silly = { timestamp: NOW, coords: { ...position.coords, speed: -1, heading: 400, accuracy: 200_000 } };
    expect(pointFromPosition(silly)).toEqual({ at: "2026-11-20T03:00:00.000Z", lat: -10.5, lon: 85.25 });
  });
});

describe("shareScreen", () => {
  const ready = { link: "open" as const, secure: true, geolocation: true, denied: false, sharing: false };

  it("follows the link first", () => {
    expect(shareScreen({ ...ready, link: "loading" })).toBe("loading");
    expect(shareScreen({ ...ready, link: "unknown", secure: false })).toBe("unknown");
    expect(shareScreen({ ...ready, link: "closed", sharing: true })).toBe("closed");
    expect(shareScreen({ ...ready, link: "error" })).toBe("error");
  });

  it("then what the browser allows", () => {
    expect(shareScreen({ ...ready, secure: false })).toBe("insecure");
    expect(shareScreen({ ...ready, geolocation: false })).toBe("unsupported");
    expect(shareScreen({ ...ready, denied: true, sharing: true })).toBe("denied");
  });

  it("then whether sharing runs", () => {
    expect(shareScreen(ready)).toBe("ready");
    expect(shareScreen({ ...ready, sharing: true })).toBe("sharing");
  });
});

describe("validateGpsSettings", () => {
  const values = { lat: "-10,5", lon: "85.25", retentionDays: "90", customerDaysAfterExit: "0" };

  it("accepts a comma or a point as the decimal sign, and both coordinates empty as no location", () => {
    expect(validateGpsSettings(values)).toEqual({
      errors: {},
      payload: { plantLocation: { lat: -10.5, lon: 85.25 }, retentionDays: 90, customerDaysAfterExit: 0 },
    });
    expect(validateGpsSettings({ ...values, lat: " ", lon: "" }).payload?.plantLocation).toBeNull();
  });

  it("names every field that is wrong", () => {
    const result = validateGpsSettings({ lat: "91", lon: "", retentionDays: "6", customerDaysAfterExit: "1,5" });
    expect(result.payload).toBeNull();
    expect(result.errors).toEqual({
      lat: "Lintang harus angka dari -90 sampai 90.",
      lon: "Isi bujur juga, atau kosongkan keduanya.",
      retentionDays: "Isi angka bulat dari 7 sampai 730.",
      customerDaysAfterExit: "Isi angka bulat dari 0 sampai 30.",
    });
    expect(validateGpsSettings({ ...values, lon: "200" }).errors).toEqual({ lon: "Bujur harus angka dari -180 sampai 180." });
    expect(validateGpsSettings({ ...values, retentionDays: "731", customerDaysAfterExit: "31" }).errors).toEqual({
      retentionDays: "Isi angka bulat dari 7 sampai 730.",
      customerDaysAfterExit: "Isi angka bulat dari 0 sampai 30.",
    });
  });
});

describe("positionLink", () => {
  it("links a truck from its SPJ on to its position page", () => {
    for (const status of ["ISSUED", "CHECKED_IN", "IN_PROCESS", "COMPLETED", "REJECTED", "issued"]) {
      expect(positionLink({ id: 7, status }), status).toBe("/lacak?trip=7");
    }
  });

  it("gives no link before the SPJ or for a trip that never ran", () => {
    for (const status of ["DRAFT", "CANCELLED", "EXPIRED"]) expect(positionLink({ id: 7, status }), status).toBeNull();
  });
});

describe("trackerExample", () => {
  it("shows the address, the header and a body with made-up values", () => {
    const example = trackerExample("https://contoh.invalid/");
    expect(example.url).toBe("https://contoh.invalid/api/gps/positions");
    expect(example.header).toBe("X-Tracker-Key");
    const body = JSON.parse(example.body) as { points: Array<Record<string, unknown>> };
    expect(body.points[0]).toMatchObject({ deviceId: "ALAT-CONTOH-01", lat: -10.5, lon: 85.25 });
    expect(Object.keys(body.points[0] ?? {})).toEqual(["deviceId", "at", "lat", "lon", "speedKph", "headingDeg", "accuracyM"]);
  });
});
