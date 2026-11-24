import { describe, expect, it } from "vitest";

import {
  formatClock,
  formatWait,
  isLongWait,
  LONG_WAIT_MINUTES,
  minutesSince,
  shapeBox,
  zoneCounts,
  zoneSummary,
} from "@/lib/control-room";

describe("shapeBox", () => {
  it("answers the bounding box of a polygon in fractions of the plan", () => {
    expect(shapeBox([[0.2, 0.5], [0.4, 0.45], [0.35, 0.8], [0.25, 0.7]])).toEqual({ x: 0.2, y: 0.45, width: 0.2, height: 0.35000000000000003 });
  });

  it("answers null without a usable polygon", () => {
    expect(shapeBox(null)).toBeNull();
    expect(shapeBox([[0, 0], [1, 1]])).toBeNull();
  });
});

describe("waiting time", () => {
  const now = new Date("2026-11-21T03:00:00Z");

  it("counts whole minutes since the truck came to its place", () => {
    expect(minutesSince("2026-11-21T02:00:30Z", now)).toBe(59);
    expect(minutesSince("2026-11-21T03:00:30Z", now)).toBe(0);
  });

  it("marks a truck as waiting long from the threshold on", () => {
    expect(LONG_WAIT_MINUTES).toBe(60);
    expect(isLongWait("2026-11-21T02:00:30Z", now)).toBe(false);
    expect(isLongWait("2026-11-21T02:00:00Z", now)).toBe(true);
    expect(isLongWait("2026-11-21T02:50:00Z", now, 10)).toBe(true);
  });

  it("writes the time of day at the plant", () => {
    expect(formatClock("2026-11-21T03:05:09Z")).toBe("10.05");
    expect(formatClock(new Date("2026-11-21T16:30:00Z"), true)).toBe("23.30.00");
  });

  it("writes minutes and hours in short Indonesian", () => {
    expect(formatWait(0)).toBe("0 mnt");
    expect(formatWait(45)).toBe("45 mnt");
    expect(formatWait(60)).toBe("1 j");
    expect(formatWait(125)).toBe("2 j 5 mnt");
  });
});

describe("zoneSummary", () => {
  it("reads the count per zone for a screen reader", () => {
    expect(
      zoneSummary(
        [
          { code: "REG", name: "Pos registrasi", kind: "REGISTRATION", color: "#e53935", shape: null },
          { code: "WB", name: "Timbangan", kind: "WEIGHBRIDGE", color: "#fdd835", shape: null },
        ],
        [
          { zone: "REG", count: 1, longest: null },
          { zone: "WB", count: 0, longest: null },
        ],
        2,
      ),
    ).toBe("Truk di dalam pabrik: 2. Pos registrasi 1 truk. Timbangan kosong.");
  });
});

describe("zoneCounts", () => {
  it("lists every zone in plan order with its short name, colour and number of trucks", () => {
    const zones = [
      { code: "REG", name: "Pos registrasi (scan barcode)", kind: "REGISTRATION", color: "#e53935", shape: null },
      { code: "WB", name: "Timbangan", kind: "WEIGHBRIDGE", color: "#fdd835", shape: null },
      { code: "GUDANG", name: "Gudang baru", kind: "OTHER", color: null, shape: null },
    ];
    const stats = [
      { zone: "WB", count: 2, longest: null },
      { zone: "REG", count: 0, longest: null },
    ];
    expect(zoneCounts(zones, stats)).toEqual([
      { code: "REG", name: "Pos registrasi", color: "#e53935", count: 0 },
      { code: "WB", name: "Timbangan", color: "#fdd835", count: 2 },
      { code: "GUDANG", name: "Gudang baru", color: null, count: 0 },
    ]);
  });
});
