// Realisation per contract and one line per truck allocation, as JSON and as CSV.
import { describe, expect, it } from "vitest";
import { seedContract } from "./helpers/fixtures.js";
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
    const later = (await ctx.call("GET", "/api/reports/contracts?direction=IN&from=2026-12-01&to=2026-12-31&activity=all", "admin4")).json().items as { contractNo: string }[];
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

describe("GET /api/reports/contracts, moving lines and pages", () => {
  /** Truck A completed on two contracts, truck B still inside on a third, and three contracts nobody touched. */
  async function plant() {
    const ctx = await weighingApp();
    await weighedIncoming(ctx);
    await ctx.incoming();
    for (const no of ["ZZ-IDLE-1", "ZZ-IDLE-2", "ZZ-IDLE-3"]) await seedContract(ctx.database, { no, partnerId: ctx.companies.supplier1, productId: ctx.products.cpo });
    return ctx;
  }
  type Row = { contractNo: string; realised: number; inProgress: number; tripCount: number };

  it("shows only lines with realisation in the period or trucks inside unless activity=all, with total and totals over the whole set", async () => {
    const ctx = await plant();
    const moving = (await ctx.call("GET", "/api/reports/contracts?from=2026-11-20&to=2026-11-20", "admin4")).json();
    expect(moving.items.some((row: Row) => row.contractNo.startsWith("ZZ-IDLE"))).toBe(false);
    expect(moving.items).toHaveLength(3);
    // truck A carries two contracts: one truck in the totals, though each of its lines counts it
    expect(moving).toMatchObject({ total: 3, limit: 50, offset: 0, totals: { realised: 31_000, tripCount: 1, realisedByUom: [{ uom: "kg", realised: 31_000 }] } });

    const all = (await ctx.call("GET", "/api/reports/contracts?from=2026-11-20&to=2026-11-20&activity=all", "admin4")).json();
    expect(all.items).toHaveLength(6);
    expect(all).toMatchObject({ total: 6, totals: { realised: 31_000, tripCount: 1 } });
    // a period without realisation: only the line whose truck is still inside moves
    const later = (await ctx.call("GET", "/api/reports/contracts?from=2026-12-01&to=2026-12-31", "admin4")).json();
    expect(later.items).toEqual([expect.objectContaining({ realised: 0, inProgress: 20_000 })]);
    expect(later).toMatchObject({ total: 1, totals: { realised: 0, tripCount: 0 } });
  });

  it("pages through the filtered set in a stable order, totals unchanged by the page", async () => {
    const ctx = await plant();
    const get = async (query: string) => (await ctx.call("GET", `/api/reports/contracts?activity=all&${query}`, "admin4")).json();
    const whole = (await get("limit=200")).items.map((row: Row) => row.contractNo) as string[];
    expect(whole).toHaveLength(6);
    expect([...whole].sort()).toEqual(whole);
    const first = await get("limit=4&offset=0");
    const second = await get("limit=4&offset=4");
    expect(first.items.map((row: Row) => row.contractNo)).toEqual(whole.slice(0, 4));
    expect(second.items.map((row: Row) => row.contractNo)).toEqual(whole.slice(4));
    expect(second).toMatchObject({ total: 6, limit: 4, offset: 4, totals: first.totals });
    expect((await get("offset=50")).items).toEqual([]);
    // the limit is capped at 200; nonsense is refused
    expect((await get("limit=500")).limit).toBe(200);
    for (const bad of ["limit=0", "offset=-1", "offset=x", "activity=some"]) {
      expect((await ctx.call("GET", `/api/reports/contracts?${bad}`, "admin4")).statusCode, bad).toBe(400);
    }
  });

  it("exports every line of the filtered set as CSV whatever limit and offset say, with the same activity filter", async () => {
    const ctx = await plant();
    const lines = async (query: string) => (await ctx.call("GET", `/api/reports/contracts?format=csv&${query}`, "admin4")).body.replace(/^﻿/, "").trim().split("\r\n");
    expect(await lines("limit=1&offset=1")).toHaveLength(1 + 3);
    expect(await lines("activity=all&limit=1")).toHaveLength(1 + 6);
  });
});

describe("GET /api/reports/trips, search and pages", () => {
  it("searches plate, trip number, contract and DO on the server and pages with total and totals", async () => {
    const ctx = await weighingApp();
    const a = await weighedIncoming(ctx, false);
    const b = await weighedIncoming(ctx, false);
    const [lineB] = await ctx.database.query<{ trip_no: string; contract_no: string }>(
      "select t.trip_no, ra.contract_no from trips t join trip_allocations ta on ta.trip_id = t.id join registration_allocations ra on ra.id = ta.registration_allocation_id where t.id = $1 order by ta.seq limit 1",
      [b.tripId],
    );
    const get = async (query: string) => (await ctx.call("GET", `/api/reports/trips?${query}`, "admin4")).json();

    const all = await get("");
    expect(all).toMatchObject({ total: 4, limit: 50, offset: 0, totals: { tripCount: 2, shareNetKg: 62_000 } });
    const page = await get("limit=3&offset=3");
    expect(page.items).toEqual([expect.objectContaining({ tripId: b.tripId, seq: 2 })]);
    expect(page).toMatchObject({ total: 4, totals: all.totals });

    // the plate as people type it, with a space and in lower case
    const spaced = `${a.plateNo.slice(0, 2)} ${a.plateNo.slice(2)}`.toLowerCase();
    expect((await get(`q=${encodeURIComponent(spaced)}`)).items.map((row: { tripId: number }) => row.tripId)).toEqual([a.tripId, a.tripId]);
    expect((await get(`q=${encodeURIComponent(lineB?.trip_no ?? "")}`)).total).toBe(2);
    const byContract = await get(`q=${encodeURIComponent(lineB?.contract_no ?? "")}`);
    expect(byContract).toMatchObject({ total: 1, totals: { tripCount: 1, shareNetKg: 20_000 } });
    expect((await get("q=TIDAK-ADA")).total).toBe(0);
    expect((await ctx.call("GET", "/api/reports/trips?limit=0", "admin4")).statusCode).toBe(400);

    const csv = await ctx.call("GET", `/api/reports/trips?format=csv&limit=1&q=${encodeURIComponent(spaced)}`, "admin4");
    expect(csv.body.replace(/^﻿/, "").trim().split("\r\n")).toHaveLength(1 + 2);
  });

  it("finds an outgoing truck by its DO number", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.outgoing();
    await ctx.forceReady(truck.tripId, "WEIGH_1");
    const weighed = await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 15_000, plateRead: truck.plateNo });
    expect(weighed.statusCode).toBe(200);
    const [order] = await ctx.database.query<{ do_no: string }>("select do_no from delivery_orders where id = $1", [truck.doIds[0]]);
    const found = (await ctx.call("GET", `/api/reports/trips?q=${encodeURIComponent(order?.do_no ?? "")}`, "admin4")).json();
    expect(found.items).toEqual([expect.objectContaining({ tripId: truck.tripId, doNo: order?.do_no })]);
  });
});
