import { isApiError, NETWORK_ERROR, SIGNED_OUT } from "@/lib/api-client";

// Text shown to users for API failures. The API's own `message` is written for
// developers, so it is never shown; the code and status decide the wording.

export function errorMessage(error: unknown): string {
  if (!isApiError(error)) return "Terjadi kesalahan yang tidak dikenal. Coba lagi.";
  if (error.code === NETWORK_ERROR) return "Server tidak bisa dihubungi. Periksa jaringan, lalu coba lagi.";
  if (error.code === SIGNED_OUT) return "Sesi berakhir. Masuk lagi untuk melanjutkan.";
  if (error.code === "NO_ROLE") return "Akun ini belum punya peran. Hubungi admin sistem.";
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
    if (error.code === "LAST_ADMIN_SELF") {
      return "Anda admin sistem terakhir, jadi peran Admin sistem tidak bisa dilepas dari akun Anda sendiri.";
    }
    if (error.code === "SELF_CHANGE") return "Anda tidak bisa menonaktifkan akun Anda sendiri.";
    if (error.code === "VALIDATION" || error.status === 400) {
      return "Pilihan peran ditolak server. Periksa lagi peran yang dicentang.";
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
  INVALID_STATE: "Status truk ini tidak memungkinkan tindakan itu. Scan ulang SPJ-nya.",
};

/** Refusals at the registration post (scan, check-in, replace card, cancel). */
export function gateErrorMessage(error: unknown): string {
  if (isApiError(error) && GATE_REFUSALS[error.code]) return GATE_REFUSALS[error.code];
  return errorMessage(error);
}

const REGISTRATION_REFUSALS: Record<string, string> = {
  DRIVER_BLACKLISTED: "Supir ini masuk daftar hitam VCF, jadi registrasi tidak bisa disimpan. Ganti supirnya.",
  DRIVER_BLOCKED: "Supir ini sedang diblokir di pabrik, jadi registrasi tidak bisa disimpan. Ganti supirnya.",
  FLOW_MISMATCH: "Kontrak yang dipilih tidak bisa digabung dalam satu registrasi karena alur barangnya berbeda.",
  TOO_MANY_ALLOCATIONS: "Terlalu banyak kontrak atau DO untuk satu registrasi.",
  DUPLICATE_IN_REGISTRATION: "Kendaraan atau supir yang sama dipakai dua kali dalam registrasi ini.",
  CONTRACT_NOT_OPEN: "Ada kontrak yang sudah tidak terbuka. Hapus kontrak itu dari registrasi.",
  DELIVERY_ORDER_NOT_OPEN: "Ada DO yang belum diterima atau sudah ditutup. Hapus DO itu dari registrasi.",
  VEHICLE_INSIDE: "Kendaraan ini masih tercatat di dalam pabrik.",
  DRIVER_INSIDE: "Supir ini masih tercatat di dalam pabrik.",
  INVALID_STATE: "Registrasi ini sudah berubah status. Muat ulang halaman, lalu coba lagi.",
};

/** Saving or sending a registration. */
export function registrationErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (REGISTRATION_REFUSALS[error.code]) return REGISTRATION_REFUSALS[error.code];
    if (error.code === "VALIDATION" || error.status === 400) {
      return "Server menolak isian ini. Periksa kolom yang ditandai, lalu kirim lagi.";
    }
    if (error.status === 403) return "Akun ini tidak punya izin membuat registrasi ini.";
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
  if (isApiError(error) && (error.code === "CARD_IN_USE" || error.code === "INVALID_STATE")) {
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
