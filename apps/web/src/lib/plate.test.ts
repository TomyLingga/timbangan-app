import { describe, expect, it } from "vitest";

import { plateDisplay, plateKey, plateError } from "@/lib/plate";

describe("plateKey", () => {
  it("removes spaces and upper-cases", () => {
    expect(plateKey("zz 0001 cth")).toBe("ZZ0001CTH");
    expect(plateKey("  ZZ\t0001  CTH ")).toBe("ZZ0001CTH");
    expect(plateKey("")).toBe("");
  });
});

describe("plateDisplay", () => {
  it("trims, upper-cases and keeps single spaces between the parts", () => {
    expect(plateDisplay("  zz   0001  cth ")).toBe("ZZ 0001 CTH");
    expect(plateDisplay("zz0001cth")).toBe("ZZ0001CTH");
  });
});

describe("plateError", () => {
  it("accepts 3 to 12 letters and digits once spaces are removed", () => {
    expect(plateError("ZZ 1 C")).toBeNull();
    expect(plateError("zz 0001 cth")).toBeNull();
    expect(plateError("ZZ 0001 CTHXYZ")).toBeNull(); // 12 characters
  });

  it("asks for a plate when the field is empty", () => {
    expect(plateError("")).toBe("Isi nomor plat.");
    expect(plateError("   ")).toBe("Isi nomor plat.");
  });

  it("refuses a plate that is too short or too long", () => {
    expect(plateError("Z1")).toBe("Plat terdiri dari 3 sampai 12 huruf dan angka.");
    expect(plateError("ZZ 0001 CTHXYZ9")).toBe("Plat terdiri dari 3 sampai 12 huruf dan angka.");
  });

  it("refuses other characters", () => {
    expect(plateError("ZZ-0001-CTH")).toBe("Plat hanya boleh berisi huruf, angka, dan spasi.");
    expect(plateError("ZZ 0001 CT#")).toBe("Plat hanya boleh berisi huruf, angka, dan spasi.");
  });
});
