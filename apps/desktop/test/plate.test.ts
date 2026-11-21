import { describe, expect, it } from "vitest";
import { comparePlates, displayPlate, normalisePlate } from "../src/shared/plate";

describe("normalisePlate", () => {
  it("keeps letters and digits in upper case, as the API compares them", () => {
    expect(normalisePlate(" xx 9876-yz ")).toBe("XX9876YZ");
    expect(normalisePlate(null)).toBe("");
  });
});

describe("displayPlate", () => {
  it("puts a space between letter and digit groups", () => {
    expect(displayPlate("XX9876YZ")).toBe("XX 9876 YZ");
  });

  it("keeps a plate that already has spaces, tidied", () => {
    expect(displayPlate(" xx  9876 yz")).toBe("XX 9876 YZ");
  });

  it("shows nothing for an empty read", () => {
    expect(displayPlate("")).toBe("");
    expect(displayPlate(null)).toBe("");
  });
});

describe("comparePlates", () => {
  it("matches after normalising both", () => {
    expect(comparePlates("XX 9876 YZ", "xx9876yz")).toBe("MATCH");
  });

  it("tells a different plate from no read", () => {
    expect(comparePlates("XX 9876 YQ", "XX9876YZ")).toBe("DIFFERENT");
    expect(comparePlates("", "XX9876YZ")).toBe("NO_READ");
    expect(comparePlates(null, "XX9876YZ")).toBe("NO_READ");
  });
});
