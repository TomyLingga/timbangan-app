import { describe, expect, it } from "vitest";

import { decisionLabel, exceptionStatusInfo, exceptionTypeLabel, needsReason, overTolerance, samePlate, waitedFor, weighingLabel } from "@/lib/weighing";

describe("weighing words", () => {
  it("names the request types and keeps an unknown one as received", () => {
    expect(exceptionTypeLabel("GROSS_IN")).toBe("Selisih bruto");
    expect(exceptionTypeLabel("NEW_KIND")).toBe("NEW_KIND");
    expect(exceptionStatusInfo("PENDING")).toEqual({ label: "Menunggu", tone: "warning" });
    expect(decisionLabel("ADD_LOAD")).toBe("Isi lagi");
    expect(decisionLabel(null)).toBeNull();
  });

  it("asks a reason only for the three weight differences", () => {
    expect(["GROSS_IN", "TARE_OUT", "NET_IN"].every((type) => needsReason(type))).toBe(true);
    expect(needsReason("PLATE")).toBe(false);
    expect(needsReason("NET_OUT")).toBe(false);
  });

  it("compares the difference with the tolerance", () => {
    expect(overTolerance({ diffPct: 1.9, tolerancePct: 0.25 })).toBe(true);
    expect(overTolerance({ diffPct: -0.1, tolerancePct: 0.25 })).toBe(false);
    expect(overTolerance({ diffPct: null, tolerancePct: 0.25 })).toBe(false);
  });

  it("says how long a request waited", () => {
    const now = Date.parse("2026-11-21T08:00:00Z");
    expect(waitedFor("2026-11-21T07:59:40Z", now)).toBe("baru saja");
    expect(waitedFor("2026-11-21T07:57:00Z", now)).toBe("3 mnt");
    expect(waitedFor("2026-11-21T06:55:00Z", now)).toBe("1 jam 5 mnt");
    expect(waitedFor("2026-11-21T06:00:00Z", now)).toBe("2 jam");
  });

  it("compares plates without case and spaces", () => {
    expect(samePlate("zz 0001 cth", "ZZ0001CTH")).toBe(true);
    expect(samePlate("ZZ0001CTN", "ZZ0001CTH")).toBe(false);
    expect(samePlate(null, "ZZ0001CTH")).toBe(false);
  });

  it("names a weighing by stage and kind", () => {
    expect(weighingLabel(1, "GROSS")).toBe("Timbang 1 (bruto)");
    expect(weighingLabel(2, "TARE")).toBe("Timbang 2 (tarra)");
  });
});
