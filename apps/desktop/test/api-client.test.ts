import { afterEach, describe, expect, it } from "vitest";
import { type FakeApi, type FakeTruck, startFakeApi } from "../dev/fake-api";
import { type ApiCallLog, createApiClient } from "../src/main/api-client";
import { createPlateReader } from "../src/main/plate-reader";

const KEY = "st1.test-key-not-a-real-secret-aaaaaaaaaaaaaaaaaaaa";
const truck = (patch: Partial<FakeTruck> = {}): FakeTruck => ({
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

let fake: FakeApi | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function setup(options: Partial<Parameters<typeof startFakeApi>[0]> = {}) {
  fake = await startFakeApi({ stationKey: KEY, pin: "4321", cameraWeigh1: 3, trucks: [truck()], ...options });
  const calls: ApiCallLog[] = [];
  const api = createApiClient({ baseUrl: fake.url, stationKey: KEY, timeoutMs: 2_000, onCall: (entry) => calls.push(entry) });
  return { fake, api, calls };
}

describe("api client", () => {
  it("reads a card with the station key and returns the API's answer", async () => {
    const { api, fake } = await setup();
    const result = await api.lookupCard("04:a1:b2:c3:d4");
    expect(result).toMatchObject({ ok: true, body: { stage: 1, kind: "GROSS", camera: 3, trip: { tripNo: "TRP-0007" }, speech: ["Plat X X satu dua tiga empat A B.", "Timbang pertama, bruto.", "Tunggu berat stabil."] } });
    expect(fake.calls[0]).toMatchObject({ method: "GET", path: "/api/weighbridge/card/04%3Aa1%3Ab2%3Ac3%3Ad4", stationKey: KEY });
  });

  it("returns the error envelope of a refused card with its code, message, speech and extra fields", async () => {
    const { api } = await setup({ trucks: [truck({ waitingStep: { code: "QC", name: "QC" } })] });
    expect(await api.lookupCard("FFFFFFFFFF")).toEqual({ ok: false, failure: { kind: "api", status: 404, code: "CARD_UNKNOWN", message: "Kartu tidak dikenal.", speech: ["Kartu tidak dikenal."], details: {} } });
    expect(await api.lookupCard("04A1B2C3D4")).toEqual({
      ok: false,
      failure: { kind: "api", status: 409, code: "NOT_READY", message: "Truk belum siap ditimbang. Langkah sekarang: QC.", speech: ["Truk belum siap ditimbang.", "Langkah sekarang: kiu si."], details: { waitingStep: "QC" } },
    });
  });

  it("is refused with STATION_UNAUTHENTICATED when the key is wrong", async () => {
    const { fake } = await setup();
    const wrong = createApiClient({ baseUrl: fake.url, stationKey: "st1.wrong", timeoutMs: 2_000 });
    expect(await wrong.lookupCard("04A1B2C3D4")).toMatchObject({ ok: false, failure: { kind: "api", status: 401, code: "STATION_UNAUTHENTICATED", speech: ["Kunci stasiun tidak valid."] } });
  });

  it("saves a weighing once even when the same request id is sent twice", async () => {
    const { api, fake } = await setup();
    const body = { cardUid: "04A1B2C3D4", weightKg: 41_500, plateRead: "XX 1234 AB", requestId: "req-00000001" };
    const first = await api.weigh(body);
    const again = await api.weigh(body);
    expect(first).toMatchObject({ ok: true, status: 200, body: { result: "SAVED", weighing: { weightKg: 41_500, stage: 1 } } });
    expect(again).toEqual(first);
    expect(fake.weighings).toHaveLength(1);
  });

  it("follows a request through heartbeats to the decision, and refuses to cancel it afterwards", async () => {
    const { api, fake } = await setup({ trucks: [truck({ check: "GROSS_IN" })] });
    const pending = await api.weigh({ cardUid: "04A1B2C3D4", weightKg: 41_500, plateRead: "XX1234AB", requestId: "req-00000002" });
    expect(pending).toMatchObject({ ok: true, status: 202, body: { result: "PENDING", exception: { type: "GROSS_IN" } } });
    const id = pending.ok && pending.body.result === "PENDING" ? pending.body.exception.id : -1;
    expect(await api.heartbeat(id, 41_480)).toMatchObject({ ok: true, body: { status: "PENDING", speech: ["Mohon tunggu keputusan atasan."] } });
    fake.decide(id, "APPROVE");
    expect(await api.heartbeat(id, 41_460)).toMatchObject({ ok: true, body: { status: "APPROVED", decision: "APPROVE", result: "SAVED", weighing: { weightKg: 41_480, mode: "EXCEPTION" } } });
    expect(await api.cancel(id, "TRUCK_LEFT")).toMatchObject({ ok: false, failure: { kind: "api", status: 409, code: "ALREADY_DECIDED" } });
  });

  it("cancels a waiting request", async () => {
    const { api } = await setup({ trucks: [truck({ check: "GROSS_IN" })] });
    const pending = await api.weigh({ cardUid: "04A1B2C3D4", weightKg: 41_500, plateRead: "XX1234AB", requestId: "req-00000003" });
    const id = pending.ok && pending.body.result === "PENDING" ? pending.body.exception.id : -1;
    expect(await api.cancel(id, "TRUCK_LEFT")).toEqual({ ok: true, status: 200, body: { status: "CANCELLED", message: "Permintaan dibatalkan. Truk belum menimbang.", speech: ["Permintaan dibatalkan.", "Truk belum menimbang."] } });
  });

  it("checks the station PIN and passes the attempts left", async () => {
    const { api } = await setup();
    expect(await api.checkPin("4321")).toMatchObject({ ok: true, body: { unlocked: true } });
    expect(await api.checkPin("0000")).toMatchObject({ ok: false, failure: { kind: "api", status: 403, code: "PIN_WRONG", details: { attemptsLeft: 4 } } });
  });

  it("gives speech audio, or null when the API answers 204", async () => {
    const off = await setup();
    expect(await off.api.speechAudio("Tempel kartu.")).toBeNull();
    await off.fake.close();
    fake = null;
    const on = await setup({ speech: "tone" });
    const audio = await on.api.speechAudio("Tempel kartu.");
    expect(audio && new TextDecoder().decode(new Uint8Array(audio).slice(0, 4))).toBe("RIFF");
  });

  it("logs each call with method, path, status and duration, and never the station key or the PIN", async () => {
    const { api, calls } = await setup();
    await api.lookupCard("04A1B2C3D4");
    await api.checkPin("4321");
    expect(calls.map((call) => [call.method, call.path, call.status])).toEqual([
      ["GET", "/api/weighbridge/card/04A1B2C3D4", 200],
      ["POST", "/api/weighbridge/manual-plate", 200],
    ]);
    expect(calls.every((call) => typeof call.ms === "number")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(JSON.stringify(calls)).not.toContain("4321");
  });
});

describe("api client without a server answer", () => {
  /** A fetch that fails the first `failures` calls, then hands over to the real one. */
  const flaky = (failures: number) => {
    let count = 0;
    const fetcher: typeof fetch = async (input, init) => {
      count++;
      if (count <= failures) throw new TypeError("fetch failed");
      return fetch(input, init);
    };
    return { fetcher, count: () => count };
  };

  it("retries an idempotent call once on a network error, with the same body", async () => {
    const { fake } = await setup();
    const net = flaky(1);
    const api = createApiClient({ baseUrl: fake.url, stationKey: KEY, timeoutMs: 2_000, fetch: net.fetcher });
    const result = await api.weigh({ cardUid: "04A1B2C3D4", weightKg: 41_500, plateRead: "XX1234AB", requestId: "req-00000004" });
    expect(result).toMatchObject({ ok: true, body: { result: "SAVED" } });
    expect(net.count()).toBe(2);
  });

  it("gives up after the one retry", async () => {
    const { fake } = await setup();
    const net = flaky(5);
    const api = createApiClient({ baseUrl: fake.url, stationKey: KEY, timeoutMs: 2_000, fetch: net.fetcher });
    expect(await api.heartbeat(1, 100)).toEqual({ ok: false, failure: { kind: "network", message: "fetch failed" } });
    expect(net.count()).toBe(2);
  });

  it("does not retry the PIN check, which counts wrong attempts", async () => {
    const { fake } = await setup();
    const net = flaky(1);
    const api = createApiClient({ baseUrl: fake.url, stationKey: KEY, timeoutMs: 2_000, fetch: net.fetcher });
    expect(await api.checkPin("4321")).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(net.count()).toBe(1);
  });

  it("times out a call that does not come back", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted"))));
    const api = createApiClient({ baseUrl: "http://localhost:9", stationKey: KEY, timeoutMs: 50, fetch: hanging });
    const started = Date.now();
    expect(await api.lookupCard("04A1B2C3D4")).toEqual({ ok: false, failure: { kind: "network", message: "Waktu tunggu habis." } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("plate reader", () => {
  it("reads the plate of a camera, and null when the reader does not know it or does not answer", async () => {
    const { fake } = await setup({ plates: { 3: "XX1234AB" } });
    const reader = createPlateReader({ baseUrl: fake.url, timeoutMs: 1_000 });
    expect(await reader.read(3)).toEqual({ plate: "XX1234AB", status: "online" });
    expect(await reader.read(9)).toBeNull();
    const down = createPlateReader({ baseUrl: "http://localhost:9", timeoutMs: 200 });
    expect(await down.read(3)).toBeNull();
  });
});
