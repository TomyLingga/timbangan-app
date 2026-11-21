import { describe, expect, it } from "vitest";

import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatQuantity,
} from "@/lib/format";

describe("formatNumber", () => {
  it("groups thousands with dots", () => {
    expect(formatNumber(1000000)).toBe("1.000.000");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(999)).toBe("999");
  });

  it("uses a comma for decimals and drops trailing zeros", () => {
    expect(formatNumber(1234.5)).toBe("1.234,5");
    expect(formatNumber("2500000.000")).toBe("2.500.000");
    expect(formatNumber("1234.5678")).toBe("1.234,568");
  });

  it("shows a dash for missing or invalid values", () => {
    expect(formatNumber(null)).toBe("-");
    expect(formatNumber(undefined)).toBe("-");
    expect(formatNumber("")).toBe("-");
    expect(formatNumber("abc")).toBe("-");
    expect(formatNumber(Number.NaN)).toBe("-");
  });
});

describe("formatQuantity", () => {
  it("appends the unit as given", () => {
    expect(formatQuantity(1000000, "Kg")).toBe("1.000.000 Kg");
    expect(formatQuantity("750000.00", "Kg")).toBe("750.000 Kg");
  });

  it("leaves the unit out when there is none", () => {
    expect(formatQuantity(1500, null)).toBe("1.500");
    expect(formatQuantity(1500, "  ")).toBe("1.500");
  });

  it("shows a dash without a quantity", () => {
    expect(formatQuantity(null, "Kg")).toBe("-");
  });
});

describe("formatPercent", () => {
  it("formats with a decimal comma", () => {
    expect(formatPercent(0.25)).toBe("0,25%");
    expect(formatPercent("0.5")).toBe("0,5%");
    expect(formatPercent(2)).toBe("2%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("shows a dash for a missing value", () => {
    expect(formatPercent(null)).toBe("-");
  });
});

describe("formatDate", () => {
  it("writes day, short Indonesian month, year", () => {
    expect(formatDate("2026-11-20")).toBe("20 Nov 2026");
    expect(formatDate("2026-05-01")).toBe("1 Mei 2026");
    expect(formatDate("2026-08-17")).toBe("17 Agu 2026");
    expect(formatDate("2026-12-31")).toBe("31 Des 2026");
  });

  it("does not shift a date-only value across time zones", () => {
    expect(formatDate("2026-01-01")).toBe("1 Jan 2026");
  });

  it("reads a timestamp in plant time (WIB)", () => {
    // 18.30 UTC on the 19th is 01.30 on the 20th in Jakarta.
    expect(formatDate("2026-11-19T18:30:00Z")).toBe("20 Nov 2026");
  });

  it("shows a dash for missing or invalid values", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDate(undefined)).toBe("-");
    expect(formatDate("")).toBe("-");
    expect(formatDate("not a date")).toBe("-");
  });
});

describe("formatDateTime", () => {
  it("adds the time with a dot separator in plant time", () => {
    expect(formatDateTime("2026-11-20T03:15:00Z")).toBe("20 Nov 2026 10.15");
    expect(formatDateTime("2026-11-20T17:05:09Z")).toBe("21 Nov 2026 00.05");
  });

  it("accepts another time zone", () => {
    expect(formatDateTime("2026-11-20T03:15:00Z", "UTC")).toBe("20 Nov 2026 03.15");
  });

  it("shows a dash for missing or invalid values", () => {
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime("x")).toBe("-");
  });
});

describe("formatDuration", () => {
  it("uses milliseconds below one second", () => {
    expect(formatDuration(850)).toBe("850 ms");
  });

  it("uses seconds with one decimal from one second up", () => {
    expect(formatDuration(1000)).toBe("1 detik");
    expect(formatDuration(2440)).toBe("2,4 detik");
    expect(formatDuration(61500)).toBe("61,5 detik");
  });

  it("shows a dash for a missing value", () => {
    expect(formatDuration(null)).toBe("-");
  });
});
