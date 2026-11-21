import { describe, expect, it } from "vitest";
import { clockTime, flowLabel, kg, parseDecimal, pct, plateOf, readyFor, signedKg } from "./format";

describe("parseDecimal", () => {
  it("reads a comma or a dot as the decimal mark", () => {
    expect(parseDecimal("3,45")).toBe(3.45);
    expect(parseDecimal("3.45")).toBe(3.45);
    expect(parseDecimal(" 12 ")).toBe(12);
  });
  it("gives null for empty input and NaN for junk", () => {
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("  ")).toBeNull();
    expect(Number.isNaN(parseDecimal("1,2,3"))).toBe(true);
    expect(Number.isNaN(parseDecimal("abc"))).toBe(true);
    expect(Number.isNaN(parseDecimal("-"))).toBe(true);
  });
});

describe("numbers", () => {
  it("writes kilograms with a dot per thousand", () => {
    expect(kg(41500)).toBe("41.500 kg");
    expect(kg(null)).toBe("–");
    expect(signedKg(500)).toBe("+500 kg");
    expect(signedKg(-1200)).toBe("−1.200 kg");
  });
  it("writes percent with a comma", () => {
    expect(pct(1.2194)).toBe("1,22%");
    expect(pct(-0.15)).toBe("−0,15%");
    expect(pct(null)).toBe("–");
  });
});

describe("plate and flow", () => {
  it("prefers the display plate", () => {
    expect(plateOf({ plateDisplay: "ZZ 0001 CTH", plateNo: "ZZ0001CTH" })).toBe("ZZ 0001 CTH");
    expect(plateOf({ plateDisplay: null, plateNo: "ZZ0001CTH" })).toBe("ZZ0001CTH");
    expect(plateOf({ plateDisplay: null, plateNo: null })).toBe("Tanpa plat");
  });
  it("names the flow in plain words", () => {
    expect(flowLabel("IN_CPO")).toBe("Masuk · CPO");
    expect(flowLabel("OUT_PACKED")).toBe("Keluar · kemasan");
    expect(flowLabel("XYZ")).toBe("XYZ");
  });
});

describe("time", () => {
  const now = new Date("2026-11-21T07:00:00Z");
  it("says how long a step has been ready", () => {
    expect(readyFor("2026-11-21T06:59:40Z", now)).toBe("baru saja");
    expect(readyFor("2026-11-21T06:48:00Z", now)).toBe("12 menit");
    expect(readyFor("2026-11-21T04:30:00Z", now)).toBe("2 jam 30 menit");
    expect(readyFor(null, now)).toBe("–");
  });
  it("shows the plant clock (WIB)", () => {
    expect(clockTime("2026-11-21T07:05:00Z")).toBe("14.05");
  });
});
