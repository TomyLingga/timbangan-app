import { describe, expect, it } from "vitest";

import { cargoMarkErrors, cargoMarkPayload, cargoMarkText, marksComplete, marksOf, needsCargoMarks, NO_MARKS, yesNoOf } from "@/lib/cargo-marks";

describe("cargo marks of an outgoing truck", () => {
  it("are asked only for the bulk outgoing flow", () => {
    expect(needsCargoMarks({ flowCode: "OUT_BULK" })).toBe(true);
    for (const flowCode of ["OUT_PACKED", "IN_CPO", "IN_GOODS", ""]) expect(needsCargoMarks({ flowCode }), flowCode).toBe(false);
  });

  it("start from what the truck already carries, and stay open for null or an older API", () => {
    expect(marksOf({ closeCargo: true, flexiBag: false })).toEqual({ closeCargo: "yes", flexiBag: "no" });
    expect(marksOf({ closeCargo: null, flexiBag: true })).toEqual({ closeCargo: "", flexiBag: "yes" });
    expect(marksOf({})).toEqual(NO_MARKS);
    expect([yesNoOf(true), yesNoOf(false), yesNoOf(null), yesNoOf(undefined)]).toEqual(["yes", "no", "", ""]);
  });

  it("are complete only when both are answered, and name the open ones", () => {
    expect(marksComplete({ closeCargo: "no", flexiBag: "no" })).toBe(true);
    expect(marksComplete({ closeCargo: "yes", flexiBag: "" })).toBe(false);
    expect(cargoMarkErrors({ closeCargo: "yes", flexiBag: "" })).toEqual({ flexiBag: "Pilih ya atau tidak." });
    expect(cargoMarkErrors(NO_MARKS)).toEqual({ closeCargo: "Pilih ya atau tidak.", flexiBag: "Pilih ya atau tidak." });
    expect(cargoMarkErrors({ closeCargo: "no", flexiBag: "yes" })).toEqual({});
  });

  it("go to the API as booleans, with an open mark left out", () => {
    expect(cargoMarkPayload({ closeCargo: "yes", flexiBag: "no" })).toEqual({ closeCargo: true, flexiBag: false });
    expect(cargoMarkPayload({ closeCargo: "", flexiBag: "no" })).toEqual({ flexiBag: false });
    expect(cargoMarkPayload(NO_MARKS)).toEqual({});
  });

  it("read as Ya, Tidak, or not marked yet", () => {
    expect([cargoMarkText(true), cargoMarkText(false), cargoMarkText(null), cargoMarkText(undefined)]).toEqual(["Ya", "Tidak", "belum ditandai", "belum ditandai"]);
  });
});
