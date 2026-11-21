// Realisation per contract and one line per truck allocation, as JSON and as CSV.
import { describe, expect, it } from "vitest";
import { weighingApp } from "./helpers/weighing.js";

type App = Awaited<ReturnType<typeof weighingApp>>;

/** An incoming truck with two contracts weighed in and out (net 31 000) and, unless told otherwise, checked out. */
async function weighedIncoming(ctx: App, checkOut = true) {
  const truck = await ctx.incoming({ contracts: [{ originNetKg: 20_000 }, { originNetKg: 11_000 }] });
  await ctx.forceReady(truck.tripId, "WEIGH_1");
  await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 41_000, plateRead: truck.plateNo });
  await ctx.forceReady(truck.tripId, "WEIGH_2");
  await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 10_000, plateRead: truck.plateNo });
  if (checkOut) {
    const back = await ctx.call("POST", "/api/gate/check-out", "pos", { cardUid: truck.cardUid });
    if (back.statusCode !== 200) throw new Error(back.body);
  }
  return truck;
}

describe("GET /api/reports/contracts", () => {
  it("shows per contract the quantity, opening, realised by completed trucks, trucks inside and what remains", async () => {
    const ctx = await weighingApp();
    const done = await weighedIncoming(ctx);
    const [first, second] = await ctx.database.query<{ contract_no: string; id: number }>(
      "select ra.contract_no, ra.contract_id::int as id from trip_allocations ta join registration_allocations ra on ra.id = ta.registration_allocation_id where ta.trip_id = $1 order by ta.seq",
      [done.tripId],
    );
    await ctx.database.query("update erp_contracts set qty_opening = 1000 where id = $1", [first?.id]);
    // a truck of another contract that is still inside
    await ctx.incoming();

    const response = await ctx.call("GET", "/api/reports/contracts?direction=IN&from=2026-11-20&to=2026-11-20", "admin4");
    expect(response.statusCode).toBe(200);
    const rows = response.json().items as { contractNo: string; inProgress: number }[];
    expect(rows.find((row) => row.contractNo === first?.contract_no)).toMatchObject({
      direction: "IN", uom: "kg", qtyContract: 500_000, qtyOpening: 1_000, realised: 20_000, realisedTotal: 20_000, inProgress: 0, remaining: 479_000, tripCount: 1,
    });
    expect(rows.find((row) => row.contractNo === second?.contract_no)).toMatchObject({ realised: 11_000, remaining: 489_000 });
    expect(rows.find((row) => row.inProgress > 0)).toMatchObject({ realised: 0, inProgress: 20_000 });
    // another period: nothing realised in it, the remainder still counts every completed truck
    const later = (await ctx.call("GET", "/api/reports/contracts?direction=IN&from=2026-12-01&to=2026-12-31", "admin4")).json().items as { contractNo: string }[];
    expect(later.find((row) => row.contractNo === first?.contract_no)).toMatchObject({ realised: 0, realisedTotal: 20_000, remaining: 479_000 });
    expect((await ctx.call("GET", `/api/reports/contracts?q=${encodeURIComponent(first?.contract_no ?? "")}`, "admin4")).json().items).toHaveLength(1);
    expect((await ctx.call("GET", "/api/reports/contracts?from=2026-12-02&to=2026-12-01", "admin4")).statusCode).toBe(400);
  });

  it("answers CSV with a header row and quoted text when asked", async () => {
    const ctx = await weighingApp();
    await weighedIncoming(ctx);
    const response = await ctx.call("GET", "/api/reports/contracts?direction=IN&format=csv", "admin4");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="realisasi-kontrak.csv"');
    const lines = response.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Nomor kontrak,Arah,Partner,Produk,Satuan,Kuantitas kontrak,Pembukaan,Realisasi periode,Realisasi total,Sedang berjalan,Sisa,Jumlah truk");
    expect(lines.slice(1).some((line) => line.includes('"PT Sawit Satu"') && line.endsWith(",20000,20000,0,480000,1"))).toBe(true);
  });
});

describe("GET /api/reports/trips", () => {
  it("lists one line per truck allocation with the weights and the share, filtered by the date of the first weighing", async () => {
    const ctx = await weighingApp();
    const truck = await weighedIncoming(ctx, false);
    const items = (await ctx.call("GET", "/api/reports/trips?from=2026-11-20&to=2026-11-20&direction=IN", "admin4")).json().items;
    expect(items).toEqual([
      expect.objectContaining({ tripId: truck.tripId, seq: 1, plateNo: truck.plateNo, grossKg: 41_000, tareKg: 10_000, truckNetKg: 31_000, shareNetKg: 20_000, splitMethod: "PROPORTIONAL", weigh1At: "2026-11-20T03:00:00.000Z", weigh2At: "2026-11-20T03:00:00.000Z" }),
      expect.objectContaining({ tripId: truck.tripId, seq: 2, shareNetKg: 11_000 }),
    ]);
    expect((await ctx.call("GET", "/api/reports/trips?from=2026-11-21", "admin4")).json().items).toEqual([]);
    expect((await ctx.call("GET", "/api/reports/trips?direction=OUT", "admin4")).json().items).toEqual([]);
    const csv = await ctx.call("GET", "/api/reports/trips?format=csv", "admin4");
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(csv.body.replace(/^﻿/, "").trim().split("\r\n")).toHaveLength(3);
  });
});
