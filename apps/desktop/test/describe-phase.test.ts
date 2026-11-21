import { describe, expect, it } from "vitest";
import { describePhase } from "../src/renderer/src/describe-phase";
import { initialScreen, type ScreenState } from "../src/shared/screen";
import { weighing } from "./fixtures";

const at = (patch: Partial<ScreenState>): ScreenState => ({ ...initialScreen(0), ...patch });

describe("describePhase", () => {
  it.each([
    [at({ phase: "idle" }), { title: "Tempel kartu", tone: "idle" }],
    [at({ phase: "truck" }), { title: "Naikkan truk ke timbangan", tone: "active" }],
    [at({ phase: "settling" }), { title: "Menunggu berat stabil", tone: "active" }],
    [at({ phase: "countdown", countdownLeft: 2 }), { title: "Berat stabil", tone: "active" }],
    [at({ phase: "sending" }), { title: "Mengirim", tone: "active" }],
    [at({ phase: "saved" }), { title: "Tersimpan", tone: "ok" }],
    [at({ phase: "plateRetry", plateAttemptsLeft: 2 }), { title: "Membaca plat lagi", detail: "Sisa 2 percobaan", tone: "warn" }],
    [at({ phase: "waiting" }), { title: "Menunggu keputusan atasan", tone: "warn" }],
    [at({ phase: "waiting", truckLeftSecondsLeft: 3 }), { title: "Menunggu keputusan atasan", detail: "Truk turun? Batal dalam 3 detik", tone: "warn" }],
  ] as const)("names %#", (state, expected) => {
    expect(describePhase(state)).toMatchObject(expected);
  });

  it.each([
    [{ kind: "SAVED", weighing: weighing(41_480), trip: null, afterDecision: true } as const, "Disetujui, tersimpan", "ok"],
    [{ kind: "NOT_SAVED", reason: "REJECTED" } as const, "Ditolak", "bad"],
    [{ kind: "NOT_SAVED", reason: "ADD_LOAD" } as const, "Tambah muatan", "warn"],
    [{ kind: "NOT_SAVED", reason: "REDUCE_LOAD" } as const, "Kurangi muatan", "warn"],
    [{ kind: "NOT_SAVED", reason: "TRUCK_LEFT" } as const, "Dibatalkan", "bad"],
  ])("names a decision %#", (outcome, title, tone) => {
    expect(describePhase(at({ phase: "decided", outcome }))).toMatchObject({ title, tone });
  });

  it.each([
    ["CARD_UNKNOWN", "Kartu tidak dikenal"],
    ["NOT_READY", "Belum siap ditimbang"],
    ["WRONG_STATION", "Bukan timbangan ini"],
    ["NETWORK", "Server tidak menjawab"],
    ["STATION_UNAUTHENTICATED", "Kunci stasiun ditolak"],
    ["SOMETHING_ELSE", "Ditolak"],
  ])("names a refusal %s", (code, title) => {
    expect(describePhase(at({ phase: "refused", outcome: { kind: "REFUSED", code } }))).toMatchObject({ title, tone: "bad" });
  });
});
