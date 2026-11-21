import { describe, expect, it } from "vitest";

import {
  formatClock,
  formatWait,
  isLongWait,
  LONG_WAIT_MINUTES,
  markerCapacity,
  markerFits,
  minutesSince,
  placeMarkers,
  shapeBox,
  zoneCounts,
  zoneSummary,
} from "@/lib/control-room";

const MARKER = { width: 60, height: 20, gap: 10 };

describe("placeMarkers", () => {
  it("places nothing for an empty zone", () => {
    expect(placeMarkers({ x: 0, y: 0, width: 200, height: 100 }, 0, MARKER)).toEqual({ slots: [], overflow: 0, overflowSlot: null });
  });

  it("puts one marker in the middle of the zone", () => {
    expect(placeMarkers({ x: 100, y: 50, width: 200, height: 100 }, 1, MARKER)).toEqual({ slots: [{ x: 200, y: 100 }], overflow: 0, overflowSlot: null });
  });

  it("fills rows from the top left and centres the group in the zone", () => {
    const { slots, overflow } = placeMarkers({ x: 0, y: 0, width: 200, height: 100 }, 4, MARKER);
    expect(slots).toEqual([
      { x: 30, y: 35 },
      { x: 100, y: 35 },
      { x: 170, y: 35 },
      { x: 30, y: 65 },
    ]);
    expect(overflow).toBe(0);
  });

  it("keeps the last place for a '+n' chip when the zone is full", () => {
    // 3 columns x 3 rows fit; 12 trucks: 8 markers and a chip for the other 4
    const placed = placeMarkers({ x: 0, y: 0, width: 200, height: 100 }, 12, MARKER);
    expect(placed.slots).toHaveLength(8);
    expect(placed.overflow).toBe(4);
    expect(placed.overflowSlot).toEqual({ x: 170, y: 80 });
  });

  it("lets a zone smaller than one marker hold one marker and the chip below it", () => {
    const placed = placeMarkers({ x: 0, y: 0, width: 30, height: 30 }, 3, MARKER);
    expect(placed.slots).toEqual([{ x: 15, y: 0 }]);
    expect(placed.overflow).toBe(2);
    expect(placed.overflowSlot).toEqual({ x: 15, y: 30 });
  });

  it("shows every truck when they all fit", () => {
    const placed = placeMarkers({ x: 0, y: 0, width: 200, height: 100 }, 9, MARKER);
    expect(placed.slots).toHaveLength(9);
    expect(placed.overflow).toBe(0);
  });
});

describe("markerCapacity", () => {
  it("counts the markers that fit without spilling, and at least one", () => {
    expect(markerCapacity({ width: 200, height: 100 }, MARKER)).toBe(9);
    expect(markerCapacity({ width: 30, height: 30 }, MARKER)).toBe(1);
  });
});

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

describe("markerFits", () => {
  const pill = { width: 82, height: 22, gap: 4 };
  it("lets a plate stick out of its zone a little, not far", () => {
    expect(markerFits({ width: 82, height: 22 }, pill)).toBe(true);
    expect(markerFits({ width: 70, height: 40 }, pill)).toBe(true);
    expect(markerFits({ width: 60, height: 40 }, pill)).toBe(false);
    expect(markerFits({ width: 200, height: 12 }, pill)).toBe(false);
  });
});
