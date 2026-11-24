import { describe, expect, it } from "vitest";

import type { ControlRoomTruck, ControlRoomZone } from "@/lib/control-room";
import { detectMoves, groupTrucksByZone, listMode, placePopover, spreadBadges, zoneLabel } from "@/lib/control-room-map";

const NOW = new Date("2026-11-23T03:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const zone = (code: string, name: string, color: string | null = "#123456"): ControlRoomZone => ({ code, name, kind: "OTHER", color, shape: null });
const ZONES = [zone("REG", "Pos registrasi (scan barcode)"), zone("QUEUE", "Parkir antrean timbang"), zone("WB", "Timbangan")];

function truck(tripId: number, zoneCode: string, sinceMinutes: number, extra: Partial<ControlRoomTruck> = {}): ControlRoomTruck {
  return {
    tripId,
    tripNo: `TRP-${tripId}`,
    plateNo: `ZZ${tripId}AA`,
    plateDisplay: `ZZ ${tripId} AA`,
    direction: "IN",
    flowCode: "IN_CPO",
    zone: zoneCode,
    stepCode: null,
    stepName: null,
    stepStatus: null,
    since: ago(sinceMinutes),
    held: null,
    ...extra,
  };
}

describe("groupTrucksByZone", () => {
  it("answers every zone in plan order with its short name, colour and count, empty zones included", () => {
    const groups = groupTrucksByZone(ZONES, [truck(1, "WB", 5)], NOW);
    expect(groups.map((group) => [group.code, group.name, group.count])).toEqual([
      ["REG", "Pos registrasi", 0],
      ["QUEUE", "Antrean timbang", 0],
      ["WB", "Timbangan", 1],
    ]);
    expect(groups[0]).toMatchObject({ color: "#123456", trucks: [], held: false, longWait: false, longest: null });
  });

  it("lists the trucks of a zone longest wait first, a tie by trip id, with their minutes", () => {
    const groups = groupTrucksByZone(ZONES, [truck(3, "QUEUE", 10), truck(2, "QUEUE", 40), truck(1, "QUEUE", 10)], NOW);
    const queue = groups.find((group) => group.code === "QUEUE");
    expect(queue?.trucks.map((row) => [row.truck.tripId, row.minutes])).toEqual([
      [2, 40],
      [1, 10],
      [3, 10],
    ]);
    expect(queue?.longest?.truck.tripId).toBe(2);
  });

  it("flags a zone that holds a truck waiting for a decision, and one where a truck has stood past the long-wait limit", () => {
    const groups = groupTrucksByZone(
      ZONES,
      [truck(1, "WB", 5, { held: { type: "GROSS_IN", since: ago(5) } }), truck(2, "QUEUE", 60), truck(3, "QUEUE", 59), truck(4, "REG", 59)],
      NOW,
    );
    const byCode = Object.fromEntries(groups.map((group) => [group.code, group]));
    expect(byCode.WB).toMatchObject({ held: true, longWait: false });
    expect(byCode.WB?.trucks[0]).toMatchObject({ held: true, long: false });
    expect(byCode.QUEUE).toMatchObject({ held: false, longWait: true });
    expect(byCode.QUEUE?.trucks.map((row) => row.long)).toEqual([true, false]);
    expect(byCode.REG).toMatchObject({ held: false, longWait: false });
  });

  it("keeps trucks in a zone the plan does not know, after the plan's zones, named by their code", () => {
    const groups = groupTrucksByZone(ZONES, [truck(1, "GUDANG", 3)], NOW);
    expect(groups.at(-1)).toMatchObject({ code: "GUDANG", name: "GUDANG", color: null, count: 1 });
  });
});

describe("zoneLabel", () => {
  it("names a zone with its number of trucks and what needs attention", () => {
    const [reg, , wb] = groupTrucksByZone(ZONES, [truck(1, "WB", 70, { held: { type: "PLATE", since: ago(3) } }), truck(2, "WB", 2), truck(3, "WB", 1)], NOW);
    expect(zoneLabel(wb!)).toBe("Timbangan, 3 truk, 1 menunggu keputusan, 1 lebih dari 60 menit");
    expect(zoneLabel(reg!)).toBe("Pos registrasi, kosong");
  });
});

describe("detectMoves", () => {
  it("finds trucks whose zone changed, and ignores trucks that arrived, left or stayed", () => {
    const before = [truck(1, "REG", 1), truck(2, "QUEUE", 1), truck(3, "WB", 1)];
    const after = [truck(1, "QUEUE", 0), truck(2, "QUEUE", 1), truck(4, "REG", 0)];
    expect(detectMoves(before, after)).toEqual({ moves: [{ tripId: 1, from: "REG", to: "QUEUE" }], skipped: 0 });
  });

  it("caps the travelling pictures and counts the moves left out", () => {
    const before = Array.from({ length: 8 }, (_, index) => truck(index + 1, "REG", 1));
    const after = before.map((item) => ({ ...item, zone: "QUEUE" }));
    const result = detectMoves(before, after, 5);
    expect(result.moves.map((move) => move.tripId)).toEqual([1, 2, 3, 4, 5]);
    expect(result.skipped).toBe(3);
  });

  it("answers no moves for the first state", () => {
    expect(detectMoves([], [truck(1, "REG", 0)])).toEqual({ moves: [], skipped: 0 });
  });
});

describe("placePopover", () => {
  const viewport = { width: 1440, height: 900 };
  const size = { width: 320, height: 240 };

  it("opens below the zone, centred on it", () => {
    expect(placePopover({ x: 500, y: 300, width: 80, height: 40 }, size, viewport)).toEqual({ left: 380, top: 348, side: "bottom" });
  });

  it("opens above the zone when there is no room below", () => {
    expect(placePopover({ x: 500, y: 700, width: 80, height: 40 }, size, viewport)).toEqual({ left: 380, top: 452, side: "top" });
  });

  it("stays inside the viewport at the left and right edges", () => {
    expect(placePopover({ x: 0, y: 100, width: 40, height: 40 }, size, viewport).left).toBe(12);
    expect(placePopover({ x: 1420, y: 100, width: 40, height: 40 }, size, viewport).left).toBe(1440 - 320 - 12);
  });

  it("takes the roomier side and keeps inside the viewport when it fits neither above nor below", () => {
    const tall = { width: 320, height: 500 };
    const placed = placePopover({ x: 500, y: 380, width: 80, height: 40 }, tall, { width: 1440, height: 800 });
    expect(placed.side).toBe("bottom");
    expect(placed.top).toBe(800 - 500 - 12);
    const higher = placePopover({ x: 500, y: 420, width: 80, height: 40 }, tall, { width: 1440, height: 800 });
    expect(higher).toMatchObject({ side: "top", top: 12 });
  });

  it("pins a popover taller than the viewport to the top margin", () => {
    expect(placePopover({ x: 500, y: 100, width: 80, height: 40 }, { width: 320, height: 1000 }, viewport).top).toBe(12);
  });
});

describe("listMode", () => {
  it("uses a bottom sheet under 640 px and a popover from there on", () => {
    expect(listMode(390)).toBe("sheet");
    expect(listMode(639)).toBe("sheet");
    expect(listMode(640)).toBe("popover");
  });
});

describe("spreadBadges", () => {
  const badge = { width: 80, height: 40 };
  const bounds = { width: 1000, height: 600 };

  it("leaves badges that do not overlap where they are", () => {
    const placed = spreadBadges(
      [
        { code: "A", x: 100, y: 100 },
        { code: "B", x: 300, y: 100 },
      ],
      badge,
      bounds,
    );
    expect(placed.get("A")).toEqual({ x: 100, y: 100 });
    expect(placed.get("B")).toEqual({ x: 300, y: 100 });
  });

  it("pushes two stacked badges apart along the axis where they overlap least, by the same amount each", () => {
    const placed = spreadBadges(
      [
        { code: "DOCK", x: 500, y: 300 },
        { code: "SEAL", x: 505, y: 320 },
      ],
      badge,
      bounds,
      4,
    );
    const dock = placed.get("DOCK")!;
    const seal = placed.get("SEAL")!;
    expect(dock.x).toBe(500);
    expect(seal.x).toBe(505);
    expect(seal.y - dock.y).toBeCloseTo(44);
    expect((dock.y + seal.y) / 2).toBeCloseTo(310);
  });

  it("separates badges side by side horizontally", () => {
    const placed = spreadBadges(
      [
        { code: "QC", x: 500, y: 300 },
        { code: "WB", x: 560, y: 300 },
      ],
      badge,
      bounds,
      4,
    );
    expect(placed.get("QC")).toEqual({ x: 488, y: 300 });
    expect(placed.get("WB")).toEqual({ x: 572, y: 300 });
  });

  it("keeps every badge inside the map, and untangles three in a row", () => {
    const placed = spreadBadges(
      [
        { code: "A", x: 10, y: 590 },
        { code: "B", x: 500, y: 300 },
        { code: "C", x: 500, y: 310 },
        { code: "D", x: 500, y: 320 },
      ],
      badge,
      bounds,
      4,
    );
    expect(placed.get("A")).toEqual({ x: 40, y: 580 });
    const ys = ["B", "C", "D"].map((code) => placed.get(code)!.y).sort((a, b) => a - b);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(43.9);
    expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(43.9);
  });
});
