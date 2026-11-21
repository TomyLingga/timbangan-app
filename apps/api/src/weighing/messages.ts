// The sentences of the weighbridge answers. Short plain Indonesian; a sentence with a plate or a weight is
// kept apart from the fixed ones (see speech.ts).
import { AppError } from "../errors.js";
import { normaliseSpeech, type Sentence, type Spoken, say } from "./speech.js";

const stageWord = (stage: 1 | 2) => (stage === 1 ? "pertama" : "kedua");
const kindWord = (kind: "GROSS" | "TARE") => (kind === "GROSS" ? "bruto" : "tarra");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const nextSentence = (stepName: string | null): Sentence[] => (stepName ? [`Berikutnya: ${stepName}.`] : []);

export const WAIT_SUPERVISOR = "Mohon tunggu keputusan atasan.";

export const messages = {
  cardUnknown: () => say("Kartu tidak dikenal."),
  cardNotInUse: () => say("Kartu tidak sedang dipakai truk."),
  wrongStation: () => say("Truk ini bukan untuk timbangan ini."),
  notReady: (stepName: string | null) => say("Truk belum siap ditimbang.", ...(stepName ? [`Langkah sekarang: ${stepName}.`] : [])),
  card: (plate: string, stage: 1 | 2, kind: "GROSS" | "TARE") =>
    say(["Plat ", { plate }, "."], `Timbang ${stageWord(stage)}, ${kindWord(kind)}.`, "Tunggu berat stabil."),
  saved: (input: { stage: 1 | 2; kind: "GROSS" | "TARE"; weightKg: number; netKg: number | null; next: string | null }) =>
    say(
      `Timbang ${stageWord(input.stage)} berhasil.`,
      [`${capital(kindWord(input.kind))} `, { kg: input.weightKg }, "."],
      ...(input.stage === 2 && input.netKg !== null ? [["Netto ", { kg: input.netKg }, "."] as Sentence] : []),
      ...nextSentence(input.next),
    ),
  plateRetry: () => say("Plat belum terbaca sesuai.", "Coba baca plat lagi."),
  pending: {
    PLATE: (read: string | null, registered: string) =>
      say("Plat tidak sesuai.", ...(read ? [["Terbaca ", { plate: read }, "."] as Sentence] : ["Plat tidak terbaca."]), ["Terdaftar ", { plate: registered }, "."], WAIT_SUPERVISOR),
    GROSS_IN: (weightKg: number, expectedKg: number) => say("Selisih bruto melewati toleransi.", ["Timbang ", { kg: weightKg }, ", surat ", { kg: expectedKg }, "."], WAIT_SUPERVISOR),
    TARE_OUT: (weightKg: number, masterKg: number | null) =>
      say(
        masterKg === null ? "Tarra master belum ada atau kendaraan belum diverifikasi." : "Tarra berbeda dengan tarra master.",
        masterKg === null ? ["Timbang ", { kg: weightKg }, "."] : ["Timbang ", { kg: weightKg }, ", master ", { kg: masterKg }, "."],
        WAIT_SUPERVISOR,
      ),
    NET_IN: (netKg: number, expectedKg: number) => say("Selisih netto melewati toleransi.", ["Netto ", { kg: netKg }, ", surat ", { kg: expectedKg }, "."], WAIT_SUPERVISOR),
    NET_OUT: (netKg: number) => say("Netto perlu diperiksa atasan.", ["Netto ", { kg: netKg }, "."], WAIT_SUPERVISOR),
  },
  waiting: () => say(WAIT_SUPERVISOR),
  rejected: (plate: boolean) => say("Permintaan ditolak.", plate ? "Supir ke pos registrasi." : "Timbang tidak disimpan."),
  retry: (code: "ADD_LOAD" | "REDUCE_LOAD") => say(code === "ADD_LOAD" ? "Muatan perlu ditambah." : "Muatan perlu dikurangi.", "Timbang tidak disimpan.", "Kembali ke tempat muat."),
  cancelled: () => say("Permintaan dibatalkan.", "Truk belum menimbang."),
  approved: () => say("Permintaan disetujui."),
  manualPlateOpen: () => say("Mode ketik plat dibuka."),
  pinWrong: (attemptsLeft: number) => say("PIN salah.", `Sisa ${attemptsLeft} kali.`),
  pinLocked: () => say("PIN terkunci sementara.", "Coba lagi nanti."),
  pinNotSet: () => say("PIN stasiun belum diatur."),
};

/**
 * The sentences above that never change, as the voice reads them. Their audio is made when the service starts,
 * so the first truck of the day does not wait for it. Keep this list in step with the messages.
 */
export const FIXED_SENTENCES: string[] = [
  "Kartu tidak dikenal.",
  "Kartu tidak sedang dipakai truk.",
  "Truk ini bukan untuk timbangan ini.",
  "Truk belum siap ditimbang.",
  "Timbang pertama, bruto.",
  "Timbang pertama, tarra.",
  "Timbang kedua, bruto.",
  "Timbang kedua, tarra.",
  "Tunggu berat stabil.",
  "Timbang pertama berhasil.",
  "Timbang kedua berhasil.",
  "Plat belum terbaca sesuai.",
  "Coba baca plat lagi.",
  "Plat tidak sesuai.",
  "Plat tidak terbaca.",
  WAIT_SUPERVISOR,
  "Selisih bruto melewati toleransi.",
  "Tarra master belum ada atau kendaraan belum diverifikasi.",
  "Tarra berbeda dengan tarra master.",
  "Selisih netto melewati toleransi.",
  "Netto perlu diperiksa atasan.",
  "Permintaan disetujui.",
  "Permintaan ditolak.",
  "Supir ke pos registrasi.",
  "Timbang tidak disimpan.",
  "Muatan perlu ditambah.",
  "Muatan perlu dikurangi.",
  "Kembali ke tempat muat.",
  "Permintaan dibatalkan.",
  "Truk belum menimbang.",
  "Permintaan tidak ditemukan.",
  "Permintaan ini sudah diputuskan.",
  "Mode ketik plat dibuka.",
  "PIN salah.",
  "PIN terkunci sementara.",
  "Coba lagi nanti.",
  "PIN stasiun belum diatur.",
  "Kunci stasiun tidak valid.",
].map(normaliseSpeech);

/** An error answer of the weighbridge routes: `{ error: { code, message, speech, ... } }`. */
export const weighbridgeError = (status: number, code: string, spoken: Spoken, extra: Record<string, unknown> = {}) =>
  new AppError(status, code, spoken.message, undefined, { speech: spoken.speech, ...extra });
