// Text shown to people for API failures. The API's own message is shown only for a 409 business refusal,
// which the API writes in Indonesian for the people using it (as the web does, apps/web/src/lib/messages.ts).

import { isApiError, NETWORK_ERROR, SIGNED_OUT, TIMEOUT } from "./client";

export function errorMessage(error: unknown): string {
  if (!isApiError(error)) return "Terjadi kesalahan. Coba lagi.";
  if (error.code === NETWORK_ERROR) return "Tidak ada sinyal ke server. Coba lagi saat sinyal ada.";
  if (error.code === TIMEOUT) return "Server terlalu lama menjawab. Coba lagi.";
  if (error.code === SIGNED_OUT) return "Sesi berakhir. Masuk lagi.";
  if (error.code === "NO_ACCESS") return "Akun ini belum diberi hak akses. Hubungi admin.";
  if (error.status === 403) return "Akun ini tidak punya izin untuk ini.";
  if (error.status === 404) return "Data tidak ditemukan lagi.";
  if (error.status === 429) return "Terlalu banyak permintaan. Tunggu sebentar.";
  if (error.status >= 500) return `Server sedang bermasalah (kode ${error.status}). Coba lagi nanti.`;
  return `Permintaan gagal (kode ${error.status}).`;
}

export function loginErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "INVALID_CREDENTIALS") return "Username atau password salah.";
    if (error.code === "TOO_MANY_ATTEMPTS") return "Terlalu banyak percobaan. Tunggu 15 menit.";
    if (error.code === "VALIDATION") return "Isi username dan password.";
  }
  return errorMessage(error);
}

/** Why a form the queue sent was refused: the API's field messages, its 409 sentence, or a general line. */
export function formRefusalMessage(error: unknown): string {
  if (isApiError(error)) {
    const fields = Object.values(error.fieldMessages);
    if (error.code === "VALIDATION" && fields.length > 0) return fields.join(" ");
    if (error.code === "UUID_REUSED") return "Kiriman ini bentrok dengan kiriman lain. Isi form lagi.";
    if (error.status === 409 && error.message.trim()) return error.message.trim();
  }
  return errorMessage(error);
}

const DECISION_REFUSALS: Record<string, string> = {
  ALREADY_DECIDED: "Permintaan ini sudah diputuskan orang lain.",
  EXCEPTION_CANCELLED: "Permintaan ini batal, misalnya truk sudah turun dari timbangan.",
  NOT_FOUND: "Permintaan ini tidak ditemukan lagi.",
};

export function decisionErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    const known = DECISION_REFUSALS[error.code];
    if (known) return known;
    const first = Object.values(error.fieldMessages)[0];
    if (error.code === "VALIDATION" && first) return first;
    if (error.status === 409 && error.message.trim()) return error.message.trim();
  }
  return errorMessage(error);
}
