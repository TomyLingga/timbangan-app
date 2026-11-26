import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-client";
import {
  EMPTY_PARTNER_ACCOUNT,
  existingPartnerOf,
  partnerAccountErrorMessage,
  partnerAccountFieldErrors,
  partnerAccountPayload,
  validatePartnerAccount,
} from "@/lib/partner-accounts";

const filled = { ...EMPTY_PARTNER_ACCOUNT, newName: " PKS Contoh Baru ", username: "pks.baru", fullName: "Admin PKS Baru", password: "rahasia-123" };

describe("a partner account made by the admin", () => {
  it("asks for a new mill's name or an existing company, a username, a name and a long enough password", () => {
    expect(validatePartnerAccount(EMPTY_PARTNER_ACCOUNT)).toEqual({
      newName: "Isi nama PKS, 2 sampai 200 huruf.",
      username: "Username 3 sampai 60 huruf, angka, titik, garis bawah, atau tanda minus.",
      fullName: "Isi nama lengkap pemakai akun.",
      password: "Kata sandi paling sedikit 8 karakter.",
    });
    expect(validatePartnerAccount(filled)).toEqual({});
    expect(validatePartnerAccount({ ...filled, choice: "existing" })).toEqual({ partner: "Pilih perusahaan." });
    expect(validatePartnerAccount({ ...filled, username: "pks baru" }).username).toBeDefined();
  });

  it("sends the new mill or the chosen company, never both", () => {
    expect(partnerAccountPayload(filled)).toEqual({ username: "pks.baru", fullName: "Admin PKS Baru", password: "rahasia-123", newPartner: { name: "PKS Contoh Baru" } });
    expect(partnerAccountPayload({ ...filled, newAddress: " Jl. Kebun 1 " }).newPartner).toEqual({ name: "PKS Contoh Baru", address: "Jl. Kebun 1" });
    expect(partnerAccountPayload({ ...filled, choice: "existing", partner: { id: "p-150", name: "Pedagang Contoh A" } })).toEqual({
      username: "pks.baru",
      fullName: "Admin PKS Baru",
      password: "rahasia-123",
      partnerId: "p-150",
    });
  });

  it("turns the refusals of the API into the form's words and fields", () => {
    const exists = new ApiError(409, "PARTNER_EXISTS", "Partner dengan nama PKS Contoh Baru sudah ada.", [], {}, { partnerId: "p-160" });
    expect(existingPartnerOf(exists, " PKS Contoh Baru ")).toEqual({ id: "p-160", name: "PKS Contoh Baru" });
    expect(existingPartnerOf(new ApiError(409, "USERNAME_TAKEN", "x"), "PKS")).toBeNull();
    expect(partnerAccountErrorMessage(new ApiError(409, "USERNAME_TAKEN", "x"))).toBe("Username ini sudah dipakai akun lain. Pilih username lain.");
    const invalid = new ApiError(400, "VALIDATION", "x", ["newPartner.name", "password"], { "newPartner.name": "Nama partner wajib diisi.", password: "Terlalu pendek." });
    expect(partnerAccountFieldErrors(invalid)).toEqual({ newName: "Nama partner wajib diisi.", password: "Terlalu pendek." });
  });
});
