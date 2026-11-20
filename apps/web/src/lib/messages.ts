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
