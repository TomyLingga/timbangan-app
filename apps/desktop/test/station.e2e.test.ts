// The main-process logic without a window: the station wired to the scale simulator, the fake API and its plate
// reader, with a clock the test moves forward.
import { afterEach, describe, expect, it } from "vitest";
import { type FakeApi, type FakeTruck, startFakeApi } from "../dev/fake-api";
import { createApiClient } from "../src/main/api-client";
import { createPlateReader } from "../src/main/plate-reader";
import { createSimulatorScale, type SimulatorScale } from "../src/main/scale/simulator";
import { createStation, type Station } from "../src/main/station";

const KEY = "st1.test-key-not-a-real-secret-aaaaaaaaaaaaaaaaaaaa";
const truck = (patch: Partial<FakeTruck>): FakeTruck => ({
  cardUid: "04A1B2C3D4",
  tripId: 7,
  tripNo: "TRP-0007",
  direction: "IN",
  plateNo: "XX1234AB",
  plateDisplay: "XX 1234 AB",
  driverName: "Supir Contoh",
  partnerName: "Pemasok Contoh",
  stage: 1,
  ...patch,
});

interface Rig {
  fake: FakeApi;
  station: Station;
  scale: SimulatorScale;
  spoken: string[][];
  logged: { event: string; data: Record<string, unknown> }[];
  advance(ms: number): Promise<void>;
  typeCard(uid: string): Promise<void>;
}

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.station.stop();
  await rig?.fake.close();
  rig = null;
});

async function setup(trucks: FakeTruck[]): Promise<Rig> {
  let now = 1_000_000;
  const fake = await startFakeApi({ stationKey: KEY, cameraWeigh1: 3, trucks, plates: { 3: "XX1234AB" }, now: () => now });
  const scale = createSimulatorScale({ intervalMs: 60_000 });
  const spoken: string[][] = [];
  const logged: { event: string; data: Record<string, unknown> }[] = [];
  let ids = 0;
  const station = createStation({
    api: createApiClient({ baseUrl: fake.url, stationKey: KEY, timeoutMs: 2_000 }),
    plateReader: createPlateReader({ baseUrl: fake.url }),
    scale,
    now: () => now,
    newRequestId: () => `e2e-${String(++ids).padStart(6, "0")}`,
    log: { write: (event, data = {}) => logged.push({ event, data }), flush: async () => {} },
    onView: () => {},
    onSpeak: (segments) => spoken.push(segments),
  });
  station.start();
  const advance = async (ms: number) => {
    for (let passed = 0; passed < ms; passed += 250) {
      now += 250;
      station.tick();
      await station.settle();
    }
  };
  const typeCard = async (uid: string) => {
    for (const key of [...uid, "Enter"]) {
      now += 5;
      station.key(key);
    }
    await station.settle();
  };
  rig = { fake, station, scale, spoken, logged, advance, typeCard };
  return rig;
}

describe("station, end to end without a window", () => {
  it("runs a first weighing that is saved: card, plate from the reader, stable weight, saved, back to waiting", async () => {
    const { fake, station, scale, spoken, logged, advance, typeCard } = await setup([truck({})]);
    await typeCard("04a1b2c3d4");
    expect(station.view().screen.phase).toBe("truck");
    expect(spoken[0]).toEqual(["Plat X X satu dua tiga empat A B.", "Timbang pertama, bruto.", "Tunggu berat stabil."]);
    scale.set(41_500);
    await advance(5_000);
    const view = station.view();
    expect(view.screen.phase).toBe("saved");
    expect(view.screen.outcome).toMatchObject({ kind: "SAVED", weighing: { weightKg: 41_500, stage: 1, kind: "GROSS" } });
    expect(fake.weighings).toEqual([expect.objectContaining({ weightKg: 41_500, plateRead: "XX1234AB", mode: "AUTO" })]);
    expect(fake.calls.some((call) => call.path === "/plate/3")).toBe(true);
    expect(fake.calls.filter((call) => call.path === "/api/weighbridge/weigh")).toHaveLength(1);
    expect(spoken.at(-1)).toEqual(["Timbang pertama berhasil.", "Bruto 41.500 kilogram.", "Berikutnya: kiu si."]);
    expect(logged.some((entry) => entry.event === "stable" && entry.data.weightKg === 41_500)).toBe(true);
    expect(view.links).toMatchObject({ scale: "connected", api: "ok", plate: "online" });
    await advance(10_000);
    expect(station.view().screen.phase).toBe("idle");
  });

  it("waits for a decision while sending the weight every 2 seconds, and shows the approved weighing with the last weight sent", async () => {
    const { fake, station, scale, spoken, advance } = await setup([truck({ check: "GROSS_IN" })]);
    station.card("04A1B2C3D4");
    await station.settle();
    scale.set(41_500);
    await advance(5_000);
    expect(station.view().screen.phase).toBe("waiting");
    expect(spoken.at(-1)?.[0]).toBe("Selisih bruto melewati toleransi.");
    const id = fake.exceptions[0]?.id ?? -1;
    await advance(6_000);
    scale.set(41_480);
    await advance(2_000);
    const beats = fake.calls.filter((call) => call.path === `/api/weighbridge/exceptions/${id}/heartbeat`);
    expect(beats.length).toBeGreaterThanOrEqual(3);
    expect(beats.at(-1)?.body).toEqual({ weightKg: 41_480 });
    fake.decide(id, "APPROVE");
    await advance(2_250);
    const view = station.view();
    expect(view.screen.phase).toBe("decided");
    expect(view.screen.outcome).toMatchObject({ kind: "SAVED", afterDecision: true, weighing: { weightKg: 41_480, mode: "EXCEPTION" } });
    expect(spoken.at(-1)?.[0]).toBe("Permintaan disetujui.");
    expect(fake.weighings).toEqual([expect.objectContaining({ weightKg: 41_480 })]);
  });

  it("cancels the request when the truck leaves the scale while waiting, and saves nothing", async () => {
    const { fake, station, scale, advance } = await setup([truck({ check: "GROSS_IN" })]);
    station.card("04A1B2C3D4");
    await station.settle();
    scale.set(41_500);
    await advance(5_000);
    expect(station.view().screen.phase).toBe("waiting");
    scale.set(250);
    // the first low reading is taken at the next tick, 250 ms later
    await advance(4_250);
    expect(station.view().screen.truckLeftSecondsLeft).toBe(1);
    await advance(1_500);
    expect(fake.calls.filter((call) => call.path.endsWith("/cancel")).map((call) => call.body)).toEqual([{ reason: "TRUCK_LEFT" }]);
    expect(fake.exceptions[0]).toMatchObject({ status: "CANCELLED", cancelReason: "TRUCK_LEFT" });
    expect(station.view().screen).toMatchObject({ phase: "decided", outcome: { kind: "NOT_SAVED", reason: "TRUCK_LEFT" }, message: "Permintaan dibatalkan. Truk belum menimbang." });
    expect(fake.weighings).toEqual([]);
  });

  it("refuses an unknown card with the API's message and speech", async () => {
    const { station, spoken, advance } = await setup([truck({})]);
    station.card("FFFFFFFFFF");
    await station.settle();
    expect(station.view().screen).toMatchObject({ phase: "refused", outcome: { kind: "REFUSED", code: "CARD_UNKNOWN" }, message: "Kartu tidak dikenal." });
    expect(spoken.at(-1)).toEqual(["Kartu tidak dikenal."]);
    await advance(10_000);
    expect(station.view().screen.phase).toBe("idle");
  });
});
