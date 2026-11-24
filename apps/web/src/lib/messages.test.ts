import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-client";
import {
  errorMessage,
  loginErrorMessage,
  saveErrorMessage,
  ssoErrorMessage,
  syncErrorMessage,
  userAdminErrorMessage,
  vcfSyncErrorMessage,
  verificationErrorMessage,
} from "@/lib/messages";

const error = (status: number, code: string) => new ApiError(status, code, "english text from the api");

describe("verificationErrorMessage", () => {
  it("says plainly that someone else already changed the vehicle", () => {
    expect(verificationErrorMessage(error(409, "INVALID_STATE"), true, "ZZ 0005 CTH")).toBe(
      "ZZ 0005 CTH sudah diverifikasi sebelumnya, mungkin oleh orang lain. Daftar dimuat ulang.",
    );
    expect(verificationErrorMessage(error(409, "INVALID_STATE"), false, "ZZ 0001 CTH")).toBe(
      "Verifikasi ZZ 0001 CTH sudah dibatalkan sebelumnya, mungkin oleh orang lain. Daftar dimuat ulang.",
    );
  });

  it("explains a vehicle that is gone and an account without the right", () => {
    expect(verificationErrorMessage(error(404, "NOT_FOUND"), true, "ZZ 0005 CTH")).toBe("Kendaraan ZZ 0005 CTH tidak ditemukan lagi. Daftar dimuat ulang.");
    expect(verificationErrorMessage(error(403, "FORBIDDEN"), true, "ZZ 0005 CTH")).toBe("Akun ini tidak punya izin mengubah verifikasi kendaraan.");
    expect(verificationErrorMessage(error(0, "NETWORK_ERROR"), true, "ZZ 0005 CTH")).toBe("Server tidak bisa dihubungi. Periksa jaringan, lalu coba lagi.");
  });
});

describe("errorMessage", () => {
  it("explains a network failure", () => {
    expect(errorMessage(error(0, "NETWORK_ERROR"))).toBe(
      "Server tidak bisa dihubungi. Periksa jaringan, lalu coba lagi.",
    );
  });

  it("explains an ended session and an account without access", () => {
    expect(errorMessage(error(401, "SIGNED_OUT"))).toBe("Sesi berakhir. Masuk lagi untuk melanjutkan.");
    expect(errorMessage(error(403, "NO_ACCESS"))).toBe("Akun ini belum diberi hak akses. Hubungi admin sistem.");
    expect(errorMessage(error(403, "FORBIDDEN"))).toBe("Akun ini tidak punya izin untuk data ini.");
  });

  it("names the status for server faults and anything unknown", () => {
    expect(errorMessage(error(502, "HTTP_502"))).toBe("Server sedang bermasalah (kode 502). Coba lagi sebentar lagi.");
    expect(errorMessage(error(418, "TEAPOT"))).toBe("Permintaan gagal (kode 418).");
    expect(errorMessage(new Error("boom"))).toBe("Terjadi kesalahan yang tidak dikenal. Coba lagi.");
  });

  it("never shows the raw API text", () => {
    expect(errorMessage(error(400, "VALIDATION"))).not.toContain("english");
  });
});

describe("loginErrorMessage", () => {
  it("covers wrong credentials and the attempt limit", () => {
    expect(loginErrorMessage(error(401, "INVALID_CREDENTIALS"))).toBe("Nama pengguna atau kata sandi salah.");
    expect(loginErrorMessage(error(429, "TOO_MANY_ATTEMPTS"))).toBe(
      "Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.",
    );
  });

  it("falls back to the general text", () => {
    expect(loginErrorMessage(error(0, "NETWORK_ERROR"))).toBe(errorMessage(error(0, "NETWORK_ERROR")));
  });
});

describe("ssoErrorMessage", () => {
  it("covers a rejected ticket and a server without SSO", () => {
    expect(ssoErrorMessage(error(401, "SSO_REJECTED"))).toBe(
      "Portal menolak tiket masuk ini. Tiket hanya bisa dipakai sekali, jadi buka lagi aplikasi ini dari Portal INL.",
    );
    expect(ssoErrorMessage(error(503, "NOT_CONFIGURED"))).toBe(
      "Masuk lewat Portal INL belum diatur di server ini. Hubungi admin sistem.",
    );
  });
});

describe("vcfSyncErrorMessage", () => {
  it("explains each way the VCF sync can fail", () => {
    expect(vcfSyncErrorMessage(error(503, "NOT_CONFIGURED"))).toBe("Sambungan ke VCF belum diatur di server ini.");
    expect(vcfSyncErrorMessage(error(409, "SYNC_RUNNING"))).toBe(
      "Pengambilan data dari VCF sedang berjalan, tunggu sampai selesai lalu coba lagi.",
    );
    expect(vcfSyncErrorMessage(error(502, "SYNC_FAILED"))).toBe(
      "VCF tidak bisa dibaca saat ini, coba lagi beberapa saat lagi.",
    );
    expect(vcfSyncErrorMessage(error(403, "FORBIDDEN"))).toBe("Akun ini tidak punya izin mengambil data dari VCF.");
  });
});

describe("saveErrorMessage", () => {
  it("uses the text given for a duplicate", () => {
    expect(saveErrorMessage(error(409, "DUPLICATE"), "Plat ini sudah terdaftar.")).toBe("Plat ini sudah terdaftar.");
  });

  it("points at the marked fields for a validation error", () => {
    expect(saveErrorMessage(error(400, "VALIDATION"), "x")).toBe(
      "Server menolak isian ini. Periksa kolom yang ditandai, lalu simpan lagi.",
    );
  });

  it("falls back to the general text", () => {
    expect(saveErrorMessage(error(0, "NETWORK_ERROR"), "x")).toBe(errorMessage(error(0, "NETWORK_ERROR")));
  });
});

describe("userAdminErrorMessage", () => {
  it("explains the last admin and the admin's own account", () => {
    expect(userAdminErrorMessage(error(409, "LAST_ADMIN"))).toBe(
      "Harus tetap ada satu akun karyawan aktif yang bisa mengatur hak akses. Beri tingkat ubah pada modul Pengguna ke akun lain dulu.",
    );
    expect(userAdminErrorMessage(error(409, "SELF_CHANGE"))).toBe("Anda tidak bisa menonaktifkan akun Anda sendiri.");
  });

  it("shows the reasons the server gives for refused permissions", () => {
    const refused = new ApiError(400, "VALIDATION", "Data yang dikirim tidak valid.", [], {
      "permissions.gate": "Modul gate tidak bisa diberikan ke akun partner.",
    });
    expect(userAdminErrorMessage(refused)).toBe("Hak akses ditolak server: Modul gate tidak bisa diberikan ke akun partner.");
    expect(userAdminErrorMessage(error(400, "VALIDATION"))).toBe("Hak akses ditolak server. Periksa lagi pilihan tiap modul.");
  });
});

describe("syncErrorMessage", () => {
  it("explains 409 and 503 in one sentence each", () => {
    expect(syncErrorMessage(error(409, "SYNC_RUNNING"))).toBe(
      "Pengambilan data dari Odoo sedang berjalan, tunggu sampai selesai lalu coba lagi.",
    );
    expect(syncErrorMessage(error(503, "NOT_CONFIGURED"))).toBe("Sambungan ke Odoo belum diatur di server ini.");
  });

  it("explains a missing permission", () => {
    expect(syncErrorMessage(error(403, "FORBIDDEN"))).toBe("Akun ini tidak punya izin mengambil data dari Odoo.");
  });
});
