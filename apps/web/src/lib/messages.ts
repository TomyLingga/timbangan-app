import { isApiError, NETWORK_ERROR, SIGNED_OUT } from "@/lib/api-client";

// Text shown to users for API failures. The API's own `message` is written for
// developers, so it is never shown; the code and status decide the wording.

export function errorMessage(error: unknown): string {
  if (!isApiError(error)) return "Terjadi kesalahan yang tidak dikenal. Coba lagi.";
  if (error.code === NETWORK_ERROR) return "Server tidak bisa dihubungi. Periksa jaringan, lalu coba lagi.";
  if (error.code === SIGNED_OUT) return "Sesi berakhir. Masuk lagi untuk melanjutkan.";
  if (error.code === "NO_ACCESS") return "Akun ini belum diberi hak akses. Hubungi admin sistem.";
  if (error.status === 403) return "Akun ini tidak punya izin untuk data ini.";
  if (error.status === 429) return "Terlalu banyak permintaan. Tunggu sebentar, lalu coba lagi.";
  if (error.status >= 500) return `Server sedang bermasalah (kode ${error.status}). Coba lagi sebentar lagi.`;
  return `Permintaan gagal (kode ${error.status}).`;
}

export function loginErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "INVALID_CREDENTIALS") return "Nama pengguna atau kata sandi salah.";
    if (error.code === "TOO_MANY_ATTEMPTS") {
      return "Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.";
    }
  }
  return errorMessage(error);
}

export function ssoErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "SSO_REJECTED") {
      return "Portal menolak tiket masuk ini. Tiket hanya bisa dipakai sekali, jadi buka lagi aplikasi ini dari Portal INL.";
    }
    if (error.code === "NOT_CONFIGURED") {
      return "Masuk lewat Portal INL belum diatur di server ini. Hubungi admin sistem.";
    }
  }
  return errorMessage(error);
}

export function vcfSyncErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "SYNC_RUNNING" || error.status === 409) {
      return "Pengambilan data dari VCF sedang berjalan, tunggu sampai selesai lalu coba lagi.";
    }
    if (error.code === "NOT_CONFIGURED" || error.status === 503) return "Sambungan ke VCF belum diatur di server ini.";
    if (error.code === "SYNC_FAILED" || error.status === 502) {
      return "VCF tidak bisa dibaca saat ini, coba lagi beberapa saat lagi.";
    }
    if (error.status === 403) return "Akun ini tidak punya izin mengambil data dari VCF.";
  }
  return errorMessage(error);
}

/** Text shown under a field the API refused. The API's own wording is not shown. */
export const FIELD_REFUSED = "Isian ini ditolak server.";

/** For create and edit forms. `duplicate` says what is already there, in the page's own words. */
export function saveErrorMessage(error: unknown, duplicate: string): string {
  if (isApiError(error)) {
    if (error.code === "DUPLICATE") return duplicate;
    if (error.code === "VALIDATION" || error.status === 400) {
      return "Server menolak isian ini. Periksa kolom yang ditandai, lalu simpan lagi.";
    }
    if (error.status === 403) return "Akun ini tidak punya izin menyimpan data ini.";
  }
  return errorMessage(error);
}

export function userAdminErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "LAST_ADMIN") {
      return "Harus tetap ada satu akun karyawan aktif yang bisa mengatur hak akses. Beri tingkat ubah pada modul Pengguna ke akun lain dulu.";
    }
    if (error.code === "SELF_CHANGE") return "Anda tidak bisa menonaktifkan akun Anda sendiri.";
    if (error.code === "VALIDATION" || error.status === 400) {
      const reasons = Object.values(error.fieldMessages);
      return reasons.length > 0
        ? `Hak akses ditolak server: ${reasons.join(" ")}`
        : "Hak akses ditolak server. Periksa lagi pilihan tiap modul.";
    }
  }
  return errorMessage(error);
}

// --- phase 3 ----------------------------------------------------------------

const GATE_REFUSALS: Record<string, string> = {
  SPJ_NOT_FOUND: "Kode SPJ ini tidak dikenal. Periksa lagi kodenya, atau minta SPJ dicetak ulang.",
  SPJ_EXPIRED: "Masa berlaku SPJ sudah lewat. Truk tidak bisa check-in dengan SPJ ini.",
  SPJ_REVOKED: "SPJ ini sudah dicabut. Truk perlu SPJ yang baru.",
  ALREADY_CHECKED_IN: "Truk ini sudah check-in. SPJ yang sama tidak bisa dipakai dua kali.",
  CARD_UNKNOWN: "Kartu ini belum terdaftar. Pakai kartu lain, atau minta admin logistik mendaftarkannya.",
  CARD_IN_USE: "Kartu ini sedang dipakai truk lain. Pakai kartu lain.",
  CARD_NOT_AVAILABLE: "Kartu ini tercatat hilang atau tidak dipakai lagi. Pakai kartu lain.",
  VEHICLE_INSIDE: "Kendaraan ini masih tercatat di dalam pabrik. Selesaikan perjalanan sebelumnya dulu.",
  DRIVER_INSIDE: "Supir ini masih tercatat di dalam pabrik. Selesaikan perjalanan sebelumnya dulu.",
  DRIVER_BLACKLISTED: "Supir masuk daftar hitam VCF. Truk tidak boleh check-in.",
  DRIVER_BLOCKED: "Supir sedang diblokir di pabrik ini. Truk tidak boleh check-in.",
  INVALID_STATE: "Status truk ini tidak memungkinkan tindakan itu. Scan ulang SPJ-nya.",
};

/**
 * A 409 with a code this app has no sentence for is a business rule of the
 * API (a driver policy can refuse WARNING drivers, for one). The API writes
 * those messages in Indonesian for the people using it, so they are shown.
 */
function refusalText(error: { status: number; message: string }): string | null {
  return error.status === 409 && error.message.trim() ? error.message.trim() : null;
}

/** Refusals at the registration post (scan, check-in, replace card, cancel, reissue). */
export function gateErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (GATE_REFUSALS[error.code]) return GATE_REFUSALS[error.code];
    const text = refusalText(error);
    if (text) return text;
  }
  return errorMessage(error);
}

const REGISTRATION_REFUSALS: Record<string, string> = {
  DRIVER_BLACKLISTED: "Supir ini masuk daftar hitam VCF, jadi registrasi tidak bisa disimpan. Ganti supirnya.",
  DRIVER_BLOCKED: "Supir ini sedang diblokir di pabrik, jadi registrasi tidak bisa disimpan. Ganti supirnya.",
  CONTRACT_NOT_AVAILABLE: "Ada kontrak yang tidak terbuka lagi atau bukan milik perusahaan Anda. Hapus kontrak itu dari registrasi.",
  DO_NOT_AVAILABLE: "Ada DO yang belum diterima, sudah ditutup, atau bukan untuk perusahaan Anda. Hapus DO itu dari registrasi.",
  DUPLICATE_VEHICLE: "Satu kendaraan dipakai dua kali dalam registrasi ini.",
  DUPLICATE_DRIVER: "Satu supir dipakai dua kali dalam registrasi ini.",
  INVALID_STATE: "Registrasi ini sudah berubah status. Muat ulang halaman, lalu coba lagi.",
};

/**
 * Saving or sending a registration. `unplaced` are the API's messages for a
 * VALIDATION refusal that the form could not show next to a field.
 */
export function registrationErrorMessage(error: unknown, unplaced: readonly string[] = []): string {
  if (isApiError(error)) {
    if (REGISTRATION_REFUSALS[error.code]) return REGISTRATION_REFUSALS[error.code];
    if (error.code === "VALIDATION" || error.status === 400) {
      return unplaced.length > 0
        ? `Server menolak isian ini: ${unplaced.join(" ")}`
        : "Server menolak isian ini. Periksa kolom yang ditandai, lalu kirim lagi.";
    }
    if (error.status === 403) return "Akun ini tidak punya izin membuat registrasi ini.";
    const text = refusalText(error);
    if (text) return text;
  }
  return errorMessage(error);
}

/** Status changes: send, accept, close, cancel, approve, reject. */
export function transitionErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "INVALID_STATE") {
      return "Statusnya sudah berubah sejak halaman ini dibuka. Muat ulang halaman, lalu coba lagi.";
    }
    if (error.status === 403) return "Akun ini tidak punya izin untuk tindakan ini.";
    if (error.code === "VALIDATION" || error.status === 400) {
      return "Server menolak isian ini. Periksa kolom yang ditandai, lalu coba lagi.";
    }
  }
  return errorMessage(error);
}

export function cardSaveErrorMessage(error: unknown): string {
  if (isApiError(error) && error.code === "INVALID_STATE") {
    return "Kartu ini sedang terikat ke truk, jadi statusnya belum bisa diubah.";
  }
  return saveErrorMessage(error, "UID kartu ini sudah terdaftar.");
}

export function syncErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "SYNC_RUNNING" || error.status === 409) {
      return "Pengambilan data dari Odoo sedang berjalan, tunggu sampai selesai lalu coba lagi.";
    }
    if (error.code === "NOT_CONFIGURED" || error.status === 503) {
      return "Sambungan ke Odoo belum diatur di server ini.";
    }
    if (error.status === 403) return "Akun ini tidak punya izin mengambil data dari Odoo.";
  }
  return errorMessage(error);
}

// --- phase 4 ----------------------------------------------------------------

const DECISION_REFUSALS: Record<string, string> = {
  ALREADY_DECIDED: "Permintaan ini sudah diputuskan orang lain. Lihat keputusannya di rincian.",
  EXCEPTION_CANCELLED: "Permintaan ini batal, misalnya karena truk sudah turun dari timbangan. Tidak ada yang perlu diputuskan.",
  NOT_FOUND: "Permintaan ini tidak ditemukan lagi.",
};

/** Refusals of POST /api/exceptions/:id/decide. */
export function decisionErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (DECISION_REFUSALS[error.code]) return DECISION_REFUSALS[error.code];
    if (error.code === "VALIDATION" && error.fieldMessages) {
      const first = Object.values(error.fieldMessages)[0];
      if (first) return first;
    }
    const text = refusalText(error);
    if (text) return text;
  }
  return errorMessage(error);
}

const CHECK_OUT_REFUSALS: Record<string, string> = {
  CARD_UNKNOWN: "Kartu ini belum terdaftar. Periksa kartunya.",
  CARD_NOT_IN_USE: "Kartu ini tidak sedang dipakai truk mana pun.",
};

/** Refusals of POST /api/gate/check-out. NOT_READY carries the step the truck is at, from the API. */
export function checkOutErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (CHECK_OUT_REFUSALS[error.code]) return CHECK_OUT_REFUSALS[error.code];
    const text = refusalText(error);
    if (text) return text;
  }
  return errorMessage(error);
}

const STATION_REFUSALS: Record<string, string> = {
  DUPLICATE: "Kode stasiun ini sudah dipakai. Pilih kode lain.",
};

export function stationErrorMessage(error: unknown): string {
  if (isApiError(error) && STATION_REFUSALS[error.code]) return STATION_REFUSALS[error.code];
  return errorMessage(error);
}