// The current step in a few words for the screen, and its colour. Pure.
import type { ScreenState } from "../../shared/screen";

export type Tone = "idle" | "active" | "ok" | "warn" | "bad";

export interface PhaseText {
  title: string;
  detail: string | null;
  tone: Tone;
}

const REFUSALS: Record<string, string> = {
  CARD_UNKNOWN: "Kartu tidak dikenal",
  NOT_READY: "Belum siap ditimbang",
  WRONG_STATION: "Bukan timbangan ini",
  NETWORK: "Server tidak menjawab",
  STATION_UNAUTHENTICATED: "Kunci stasiun ditolak",
};

export function describePhase(state: ScreenState): PhaseText {
  const text = (title: string, tone: Tone, detail: string | null = null): PhaseText => ({ title, detail, tone });
  switch (state.phase) {
    case "idle":
      return text("Tempelkan kartu RFID", "idle", "Pastikan truk sudah naik penuh ke timbangan.");
    case "lookup":
      return text("Membaca kartu", "active");
    case "truck":
      return text("Naikkan truk ke timbangan", "active");
    case "settling":
      return text("Menunggu berat stabil", "active");
    case "countdown":
      return text("Berat stabil", "active", "Truk jangan bergerak");
    case "sending":
      return text("Mengirim", "active");
    case "saved":
      return text("Tersimpan", "ok");
    case "plateRetry":
      return text("Membaca plat lagi", "warn", state.plateAttemptsLeft === null ? null : `Sisa ${state.plateAttemptsLeft} percobaan`);
    case "waiting":
      return text("Menunggu keputusan atasan", "warn", state.truckLeftSecondsLeft === null ? null : `Truk turun? Batal dalam ${state.truckLeftSecondsLeft} detik`);
    case "decided": {
      const outcome = state.outcome;
      if (outcome?.kind === "SAVED") return text("Disetujui, tersimpan", "ok");
      if (outcome?.kind !== "NOT_SAVED") return text("Selesai", "idle");
      switch (outcome.reason) {
        case "HOLD":
          return text("Mundur, tidak disimpan", "warn");
        case "REJECTED":
          return text("Truk ditolak", "bad");
        case "ADD_LOAD":
          return text("Tambah muatan", "warn");
        case "REDUCE_LOAD":
          return text("Kurangi muatan", "warn");
        case "CANCELLED":
        case "TRUCK_LEFT":
          return text("Dibatalkan", "bad");
        default:
          return text("Tidak disimpan", "bad");
      }
    }
    case "refused": {
      const code = state.outcome?.kind === "REFUSED" ? state.outcome.code : "";
      return text(REFUSALS[code] ?? "Ditolak", "bad");
    }
  }
}
