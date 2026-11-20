import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-client";
import { errorMessage, loginErrorMessage, ssoErrorMessage, syncErrorMessage } from "@/lib/messages";

const error = (status: number, code: string) => new ApiError(status, code, "english text from the api");

describe("errorMessage", () => {
  it("explains a network failure", () => {
    expect(errorMessage(error(0, "NETWORK_ERROR"))).toBe(
      "Server tidak bisa dihubungi. Periksa jaringan, lalu coba lagi.",
    );
  });

  it("explains an ended session and a missing role", () => {
    expect(errorMessage(error(401, "SIGNED_OUT"))).toBe("Sesi berakhir. Masuk lagi untuk melanjutkan.");
    expect(errorMessage(error(403, "NO_ROLE"))).toBe("Akun ini belum punya peran. Hubungi admin sistem.");
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
