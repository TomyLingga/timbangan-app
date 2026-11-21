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
