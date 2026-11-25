import { describe, expect, it, vi } from "vitest";

import { readStatus, rememberedDevice, scanFailureOf, scannerMessage, scannerStatus, ScannerError, scanPage, scanUrl, statusUrl } from "@/lib/scanner";

const BASE = "http://helper.test:7879";
const FLATBED = { id: "{6BDD1FC6-0001}\\0000", name: "Scanner Contoh 100" };
const FEEDER = { id: "{6BDD1FC6-0002}\\0001", name: "Scanner Contoh 200 ADF" };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch double that answers from a queue and records the address and options of every call. */
function fakeFetch(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected fetch call");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: mock as unknown as typeof fetch, calls };
}

describe("addresses of the helper", () => {
  it("are the paths of the helper the old application installed, with the scanner only when one is chosen", () => {
    expect(statusUrl(BASE, null, 17)).toBe(`${BASE}/status?t=17`);
    expect(statusUrl(BASE, FLATBED.id, 17)).toBe(`${BASE}/status?t=17&device=%7B6BDD1FC6-0001%7D%5C0000`);
    expect(scanUrl(BASE, null, 200)).toBe(`${BASE}/scan?dpi=200`);
    expect(scanUrl(BASE, FEEDER.id, 300)).toBe(`${BASE}/scan?dpi=300&device=%7B6BDD1FC6-0002%7D%5C0001`);
  });
});

describe("readStatus", () => {
  it("reads the scanner the helper would use, its feeder and the other scanners", () => {
    const answer = { ok: true, version: "2026-10-16.1", dpi: 200, scanners: [FLATBED, FEEDER], selected: { ...FEEDER, feeder: true, feeder_ready: false }, scanner: FEEDER.name };
    expect(readStatus(answer)).toEqual({ state: "ready", device: FEEDER, devices: [FLATBED, FEEDER], feederReady: false, version: "2026-10-16.1" });
    // a driver that does not report its feeder
    expect(readStatus({ ok: true, scanners: [FLATBED], selected: { ...FLATBED, feeder: null, feeder_ready: null } })).toMatchObject({ state: "ready", feederReady: null, version: null });
  });

  it("says no scanner when the helper found none, or not the one asked for", () => {
    expect(readStatus({ ok: false, version: "2026-10-16.1", scanners: [], selected: null, message: "WIA tidak menemukan scanner di PC ini" })).toEqual({
      state: "no-scanner", devices: [], version: "2026-10-16.1",
    });
    expect(readStatus({ ok: false, scanners: [FLATBED], selected: null })).toEqual({ state: "no-scanner", devices: [FLATBED], version: null });
  });

  it("does not trust an answer that is not a status", () => {
    for (const body of [null, "ok", [], { ok: true }, { ok: true, selected: { name: "tanpa id" } }, { ok: "true", selected: FLATBED }]) {
      expect(readStatus(body).state, JSON.stringify(body)).toBe("no-scanner");
    }
    expect(readStatus({ ok: false, scanners: [{ id: 7 }, null, { id: "a" }] })).toMatchObject({ devices: [{ id: "a", name: "a" }] });
  });
});

describe("scannerStatus", () => {
  it("asks the helper with a plain GET and answers what it says", async () => {
    const { fetch, calls } = fakeFetch(json(200, { ok: true, scanners: [FLATBED], selected: { ...FLATBED, feeder_ready: true } }));
    const status = await scannerStatus(null, { base: BASE, fetch, now: () => 5 });
    expect(status).toMatchObject({ state: "ready", device: FLATBED, feederReady: true });
    expect(calls[0]?.url).toBe(`${BASE}/status?t=5`);
    // nothing that would make the browser send a preflight, and no cookies
    expect(calls[0]?.init.headers).toBeUndefined();
    expect(calls[0]?.init.credentials).toBeUndefined();
    expect(calls[0]?.init.method).toBeUndefined();
  });

  it("answers offline when nothing listens, the answer is not JSON, or it takes too long", async () => {
    expect(await scannerStatus(null, { base: BASE, fetch: fakeFetch(new TypeError("Failed to fetch")).fetch })).toEqual({ state: "offline" });
    expect(await scannerStatus(null, { base: BASE, fetch: fakeFetch(new Response("<html>", { status: 200 })).fetch })).toEqual({ state: "offline" });
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(await scannerStatus(null, { base: BASE, fetch: fakeFetch(abort).fetch })).toEqual({ state: "offline" });
  });
});

describe("scanPage", () => {
  it("answers the page as a JPEG file named by the time of the scan", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const { fetch, calls } = fakeFetch(new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg", "x-scan-seconds": "6.2" } }));
    const file = await scanPage(FEEDER.id, { base: BASE, fetch, now: () => 1234 });
    expect([file.name, file.type, file.size]).toEqual(["scan-1234.jpg", "image/jpeg", 7]);
    expect(calls[0]?.url).toBe(scanUrl(BASE, FEEDER.id, 200));
  });

  it("tells an empty feeder, a missing scanner, a failed scan and a helper that is gone apart", async () => {
    const kindOf = async (answer: Response | Error) => {
      const failure = await scanPage(null, { base: BASE, fetch: fakeFetch(answer).fetch }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ScannerError);
      return (failure as ScannerError).kind;
    };
    expect(await kindOf(json(409, { ok: false, message: "Tidak ada kertas di feeder scanner." }))).toBe("NO_PAPER");
    expect(await kindOf(json(404, { ok: false }))).toBe("NO_SCANNER");
    expect(await kindOf(json(500, { ok: false, message: "Scan gagal" }))).toBe("FAILED");
    expect(await kindOf(new TypeError("Failed to fetch"))).toBe("OFFLINE");
    expect(await kindOf(new Response(new Uint8Array(), { status: 200 }))).toBe("FAILED");
    expect([scanFailureOf(409), scanFailureOf(404), scanFailureOf(500), scanFailureOf(502)]).toEqual(["NO_PAPER", "NO_SCANNER", "FAILED", "FAILED"]);
  });
});

describe("what the operator reads", () => {
  it("offers the file picker whenever the scanner cannot be used, and asks for paper when there is none", () => {
    expect(scannerMessage("OFFLINE")).toBe("Pembantu scanner di PC ini tidak menjawab. Jalankan scanner-helper di PC pos, atau pilih berkas scan.");
    for (const kind of ["OFFLINE", "NO_SCANNER", "FAILED"] as const) expect(scannerMessage(kind)).toContain("pilih berkas scan");
    expect(scannerMessage("NO_PAPER")).toBe("Tidak ada kertas di scanner. Masukkan dokumen, lalu pindai lagi.");
  });

  it("keeps the scanner chosen earlier only while the helper still lists it", () => {
    expect(rememberedDevice([FLATBED, FEEDER], FEEDER.id)).toBe(FEEDER.id);
    expect(rememberedDevice([FLATBED], FEEDER.id)).toBeNull();
    expect(rememberedDevice([FLATBED], null)).toBeNull();
  });
});
