import { describe, expect, it } from "vitest";

import { documentTotals, planPerTruck, splitQuantity, wholeKg } from "@/lib/quantity";

describe("splitQuantity", () => {
  it("splits evenly when the quantity divides", () => {
    expect(splitQuantity(40000, 4)).toEqual([10000, 10000, 10000, 10000]);
  });

  it("rounds each share down to the kilogram and gives the rest to the last truck", () => {
    expect(splitQuantity(38002, 4)).toEqual([9500, 9500, 9500, 9502]);
    expect(splitQuantity(10, 3)).toEqual([3, 3, 4]);
  });

  it("keeps a fraction of the total on the last truck, so the shares add up", () => {
    expect(splitQuantity(1000.5, 2)).toEqual([500, 500.5]);
  });

  it("gives one truck everything", () => {
    expect(splitQuantity(12345, 1)).toEqual([12345]);
  });

  it("returns no shares without trucks or without a usable quantity", () => {
    expect(splitQuantity(1000, 0)).toEqual([]);
    expect(splitQuantity(Number.NaN, 2)).toEqual([]);
    expect(splitQuantity(-5, 2)).toEqual([]);
  });

  it("splits zero into zeros", () => {
    expect(splitQuantity(0, 3)).toEqual([0, 0, 0]);
  });
});

describe("planPerTruck", () => {
  it("adds the share of every delivery order per truck", () => {
    const plan = planPerTruck([{ qty: 38002 }, { qty: 2000 }], 4);
    expect(plan.perTruck).toEqual([10000, 10000, 10000, 10002]);
    expect(plan.perOrder).toEqual([
      [9500, 9500, 9500, 9502],
      [500, 500, 500, 500],
    ]);
  });

  it("treats an order without quantity as zero", () => {
    expect(planPerTruck([{ qty: null }], 2).perTruck).toEqual([0, 0]);
  });
});

describe("documentTotals", () => {
  it("takes the smallest tare above zero, sums the net and adds both for the gross", () => {
    expect(
      documentTotals([
        { originGrossKg: 30000, originTareKg: 10000, originNetKg: 20000 },
        { originGrossKg: null, originTareKg: 9800, originNetKg: 5000 },
        { originGrossKg: null, originTareKg: 0, originNetKg: 1000 },
      ]),
    ).toEqual({ grossKg: 35800, tareKg: 9800, netKg: 26000 });
  });

  it("reads numbers sent as text", () => {
    expect(documentTotals([{ originGrossKg: "", originTareKg: "8000", originNetKg: "21000.000" }])).toEqual({
      grossKg: 29000,
      tareKg: 8000,
      netKg: 21000,
    });
  });

  it("is empty while no net weight is filled", () => {
    expect(documentTotals([{ originGrossKg: 30000, originTareKg: 10000, originNetKg: null }])).toEqual({
      grossKg: null,
      tareKg: null,
      netKg: null,
    });
    expect(documentTotals([])).toEqual({ grossKg: null, tareKg: null, netKg: null });
  });

  it("has a net but no gross when no tare above zero is known", () => {
    expect(documentTotals([{ originGrossKg: null, originTareKg: null, originNetKg: 5000 }])).toEqual({
      grossKg: null,
      tareKg: null,
      netKg: 5000,
    });
  });
});

describe("wholeKg", () => {
  it("reads a whole number of kilograms", () => {
    expect(wholeKg("12000")).toBe(12000);
    expect(wholeKg(" 7 ")).toBe(7);
  });

  it("refuses anything else", () => {
    expect(wholeKg("")).toBeNull();
    expect(wholeKg("12.000")).toBeNull();
    expect(wholeKg("1,5")).toBeNull();
    expect(wholeKg("-3")).toBeNull();
    expect(wholeKg("abc")).toBeNull();
  });
});
