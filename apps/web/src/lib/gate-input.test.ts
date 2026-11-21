import { describe, expect, it } from "vitest";

import { cardUidError, normalizeCardUid, normalizeSpjToken, spjTokenError } from "@/lib/gate-input";

describe("normalizeSpjToken", () => {
  it("upper-cases and removes spaces and dashes", () => {
    expect(normalizeSpjToken(" ab3d-ef7h 9kmn ")).toBe("AB3DEF7H9KMN");
  });

  it("reads I and L as 1 and O as 0, as the API does", () => {
    expect(normalizeSpjToken("iloO")).toBe("1100");
  });
});

describe("spjTokenError", () => {
  it("accepts twelve characters of the token alphabet", () => {
    expect(spjTokenError("AB3DEF7H9KMN")).toBeNull();
    expect(spjTokenError("0123456789XZ")).toBeNull();
  });

  it("explains a wrong length", () => {
    expect(spjTokenError("")).toBe("Scan barcode SPJ atau ketik kodenya.");
    expect(spjTokenError("AB3D")).toBe("Kode SPJ terdiri dari 12 huruf dan angka. Periksa lagi kodenya.");
  });

  it("refuses letters the token never uses", () => {
    expect(spjTokenError("AB3DEF7H9KMU")).toBe("Kode ini bukan kode SPJ. Periksa lagi kodenya.");
  });
});

describe("normalizeCardUid", () => {
  it("upper-cases and removes separators", () => {
    expect(normalizeCardUid("0a:1b-2c 3d")).toBe("0A1B2C3D");
  });
});

describe("cardUidError", () => {
  it("accepts hexadecimal", () => {
    expect(cardUidError("0A1B2C3D")).toBeNull();
  });

  it("explains an empty or malformed UID", () => {
    expect(cardUidError("")).toBe("Tempelkan kartu ke pembaca, atau ketik UID kartu.");
    expect(cardUidError("XYZ123")).toBe("UID kartu hanya berisi angka 0 sampai 9 dan huruf A sampai F.");
    expect(cardUidError("0A1")).toBe("UID kartu terdiri dari 4 sampai 32 karakter.");
  });
});
