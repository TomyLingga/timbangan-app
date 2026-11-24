// GET /api/history/trips and /api/history/trips/:id: reading the archive of the old application. The archive is
// filled through the importer from made-up old rows.
import { describe, expect, it } from "vitest";
import { importLegacy } from "../src/legacy/import.js";
import { testApp } from "./helpers/app.js";
import { FakeLegacyReader, registration, weighing } from "./helpers/fake-legacy.js";
import { seedCompany, seedContract, seedProduct } from "./helpers/fixtures.js";
import { bearer, seedPartner, seedPartnerUser, seedStaff } from "./helpers/users.js";

const OLD = {
  registrasi: [
    registration(1, { tgl_entry: "2026-11-20", driver_name: "Supir Rekaan" }),
    registration(2, {
      jenis: "2", jenis_material: "3", signature: "SBY", tgl_entry: "2026-11-21", no_polisi: "bk-9002-xb", origin: "001/DO-REK/REK/XI/2026",
      no_do: "001/DO-REK/REK/XI/2026", driver_name: "Supir Kedua",
    }),
    // one truck with two contracts
    registration(3, { tgl_entry: "2026-11-22", no_polisi: "BK 9003 XC", origin: "0003/KONTRAK/REK/XI/2026", driver_name: "Supir Ketiga" }),
    registration(4, { tgl_entry: "2026-11-22", no_polisi: "BK 9003 XC", origin: "0004/KONTRAK/REK/XI/2026", driver_name: "Supir Ketiga", parent_id: 3 }),
    // a reference that is not a contract pulled from the ERP, and one left empty
    registration(5, { tgl_entry: "2026-11-23", type: "IN", finish: "2", no_polisi: "BK 9005 XE", driver_name: "Supir Kelima", origin: "777/SPK/LAIN/XI/2026" }),
    registration(6, { tgl_entry: "2026-11-23", type: "IN", finish: "4", no_polisi: "BK 9006 XF", driver_name: "Supir Keenam", origin: "" }),
  ],
  timbangan: [
    weighing(11, 1, { netto: "25005" }),
    weighing(12, 2, { netto: "18000" }),
    weighing(13, 3, { bruto: "40000", tarra: "22000", netto: "10000" }),
    weighing(14, 4, { bruto: "40000", tarra: "22000", netto: "8000" }),
    weighing(16, 6, { netto: "30000" }),
  ],
  qcpass: [{ id: 31, reg_id: 3, ffa: "3.20" }],
  selisih_approval: [{ id: 41, reg_id: 3, signature: "SMK", tipe: "NETTO_IN", status: "APPROVED", requested_at: "2026-11-22T09:00:00", selisih_id: 51 }],
  selisih: [{ id: 51, no_ba: "BA-REK/051", tgl_ba: "2026-11-22T10:00:00", reg_id: 3 }],
};

async function setup() {
  const context = await testApp();
  await importLegacy(context.database, new FakeLegacyReader(OLD), { only: ["trips", "exceptions"] }, () => new Date("2026-11-24T03:00:00Z"));
  // contracts pulled from the ERP: the first in another case and with spaces, the third, and an outgoing one
  // carrying the number of the fourth (another direction, so the fourth stays without a contract)
  const supplier = await seedCompany(context.database, "PT Sawit Rekaan", { supplier: true });
  const product = await seedProduct(context.database, "CPO", "CPO");
  await seedContract(context.database, { no: " 0001/kontrak/rek-a/b-cd/xi/2026 ", partnerId: supplier, productId: product });
  await seedContract(context.database, { no: "0003/KONTRAK/REK/XI/2026", partnerId: supplier, productId: product });
  await seedContract(context.database, { no: "0004/KONTRAK/REK/XI/2026", partnerId: supplier, productId: product, direction: "OUT" });
  await seedStaff(context.database, "reader", { reports: "VIEW" });
  await seedStaff(context.database, "other", { gate: "VIEW" });
  await seedPartnerUser(context.database, "partner", await seedPartner(context.database, "PT Contoh Rekaan", { supplier: true, transporter: true }), {
    contracts: "EDIT", registrations: "EDIT", delivery_orders: "EDIT", vehicles: "EDIT", drivers: "EDIT",
  });
  const get = async (url: string, username = "reader") => context.app.inject({ method: "GET", url, headers: await bearer(context.app, username) });
  return { ...context, get };
}

const legacyIds = (items: { legacyId: number }[]) => items.map((item) => item.legacyId);

describe("GET /api/history/trips", () => {
  it("lists the archive newest entry first, with the total and the totals over every matching row", async () => {
    const { get } = await setup();
    const response = await get("/api/history/trips");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(legacyIds(body.items)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(body).toMatchObject({ total: 6, limit: 50, offset: 0, totals: { trucks: 5, completedTrucks: 3, netKg: 61_005 } });
    expect(body.items[5]).toEqual({
      id: expect.any(Number), site: "SMK", legacyId: 1, ticketNo: "5001", direction: "IN", material: "CPO", state: "COMPLETED", entryDate: "2026-11-20",
      arrivedAt: "2026-11-20T01:00:00.000Z", leftAt: "2026-11-20T03:00:00.000Z", plateText: "BK 9001 XA", plateNo: "BK9001XA", driverName: "Supir Rekaan",
      licenceNo: "SIMREKAAN01", transporter: "PT Angkut Rekaan", partnerName: "PT Sawit Rekaan", mill: "PKS Rekaan", productName: "CPO", uom: "Kg",
      reference: "0001/KONTRAK/REK-A/B-CD/XI/2026", doNo: "-", poNo: null, spbNo: "SPB-REK-1", handoverNo: null, docGrossKg: 40_000, docTareKg: 15_000, docNetKg: 25_000,
      grossKg: 40_010, tareKg: 15_005, netKg: 25_005, weigh1At: "2026-11-20T01:30:00.000Z", weigh2At: "2026-11-20T02:40:00.000Z", weigh1By: "petugas1", weigh2By: "petugas2",
      groupId: null, closeCargo: false, flexiBag: false, contractKnown: true,
    });
    expect(body.items[0]).not.toHaveProperty("details");
  });

  it("finds by plate in any case and spacing, ticket number, contract or DO reference, and driver name", async () => {
    const { get } = await setup();
    const found = async (q: string) => legacyIds((await get(`/api/history/trips?q=${encodeURIComponent(q)}`)).json().items);
    expect(await found("bk9002xb")).toEqual([2]);
    expect(await found("bk 9003")).toEqual([4, 3]);
    expect(await found("5006")).toEqual([6]);
    expect(await found("do-rek")).toEqual([2]);
    expect(await found("0004/kontrak")).toEqual([4]);
    expect(await found("supir keenam")).toEqual([6]);
    expect(await found("tidak-ada")).toEqual([]);
  });

  it("filters by entry date, direction, state and site, and refuses a period that ends before it starts", async () => {
    const { get } = await setup();
    const ids = async (query: string) => legacyIds((await get(`/api/history/trips?${query}`)).json().items);
    expect(await ids("from=2026-11-21&to=2026-11-22")).toEqual([4, 3, 2]);
    expect(await ids("direction=OUT")).toEqual([2]);
    expect(await ids("state=REJECTED_QC")).toEqual([6]);
    expect(await ids("state=UNFINISHED")).toEqual([5]);
    expect(await ids("site=sby")).toEqual([2]);
    const filtered = (await get("/api/history/trips?direction=IN&state=COMPLETED")).json();
    expect(filtered).toMatchObject({ total: 3, totals: { trucks: 2, completedTrucks: 2, netKg: 43_005 } });

    const wrong = await get("/api/history/trips?from=2026-11-22&to=2026-11-21");
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.fields).toEqual([{ field: "to", message: "Tanggal akhir tidak boleh sebelum tanggal awal." }]);
    expect((await get("/api/history/trips?direction=SIDEWAYS")).statusCode).toBe(400);
    expect((await get("/api/history/trips?state=DONE")).statusCode).toBe(400);
    expect((await get("/api/history/trips?from=22-11-2026")).statusCode).toBe(400);
  });

  it("says per row whether its incoming reference is a contract pulled from the ERP", async () => {
    const { get } = await setup();
    const items: { legacyId: number; contractKnown: boolean | null }[] = (await get("/api/history/trips")).json().items;
    expect(Object.fromEntries(items.map((item) => [item.legacyId, item.contractKnown]))).toEqual({
      1: true, // matched in another case and with spaces
      2: null, // outgoing: its reference is a DO number, never flagged
      3: true,
      4: false, // the same number exists only as an outgoing contract
      5: false,
      6: null, // no reference
    });
  });

  it("filters the incoming trucks without a known contract, together with the other filters", async () => {
    const { get } = await setup();
    const ids = async (query: string) => legacyIds((await get(`/api/history/trips?${query}`)).json().items);
    const missing = (await get("/api/history/trips?contract=missing")).json();
    expect(legacyIds(missing.items)).toEqual([5, 4]);
    expect(missing.items.every((item: { contractKnown: boolean | null }) => item.contractKnown === false)).toBe(true);
    expect(missing).toMatchObject({ total: 2, totals: { trucks: 2, completedTrucks: 1, netKg: 8_000 } });
    expect(await ids("contract=missing&state=UNFINISHED")).toEqual([5]);
    expect(await ids("contract=missing&state=COMPLETED")).toEqual([4]);
    expect(await ids("contract=missing&from=2026-11-22&to=2026-11-22")).toEqual([4]);
    expect(await ids("contract=missing&q=bk%209005")).toEqual([5]);
    expect(await ids("contract=missing&q=supir%20rekaan")).toEqual([]);
    expect(await ids("contract=missing&direction=OUT")).toEqual([]);
    expect((await get("/api/history/trips?contract=missing&limit=1&offset=1")).json()).toMatchObject({ total: 2, items: [{ legacyId: 4 }] });
    expect((await get("/api/history/trips?contract=all")).statusCode).toBe(400);
  });

  it("pages with limit and offset, at most 200 rows a page", async () => {
    const { get } = await setup();
    const page = (await get("/api/history/trips?limit=2&offset=2")).json();
    expect(legacyIds(page.items)).toEqual([4, 3]);
    expect(page).toMatchObject({ total: 6, limit: 2, offset: 2 });
    expect((await get("/api/history/trips?limit=500")).json().limit).toBe(200);
    expect((await get("/api/history/trips?limit=0")).statusCode).toBe(400);
  });

  it("exports every matching row as CSV", async () => {
    const { get } = await setup();
    const response = await get("/api/history/trips?format=csv&direction=IN&limit=1");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="riwayat-lama.csv"');
    const lines = response.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(
      "Cabang,Id lama,Nomor tiket,Arah,Keadaan,Tanggal entry,Masuk,Keluar,Plat,Supir,SIM,Transporter,Partner,Asal PKS,Produk,Satuan,Kontrak atau DO,Nomor DO,PO,SPB,Nomor penyerahan,Bruto surat,Tarra surat,Netto surat,Bruto,Tarra,Netto,Timbang 1,Timbang 2,Kelompok,Close cargo,Flexi bag",
    );
    expect(lines[5]).toContain('"SMK",1,"5001","IN","COMPLETED","2026-11-20"');
  });
});

describe("GET /api/history/trips/:id", () => {
  it("answers every stored field, the other rows of its multi-contract group, and its approvals with the BA number", async () => {
    const { get, database } = await setup();
    const [row] = await database.query<{ id: number }>("select id::int as id from legacy_trips where legacy_id = 3");
    const response = await get(`/api/history/trips/${row?.id}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.trip).toMatchObject({ legacyId: 3, groupId: 3, netKg: 10_000, contractKnown: true, importedAt: "2026-11-24T03:00:00.000Z", updatedAt: "2026-11-24T03:00:00.000Z" });
    expect(body.trip.details).toMatchObject({ qc: { id: 31, ffa: "3.20" }, flags: { finish: "1" } });
    expect(legacyIds(body.group)).toEqual([4]);
    expect(body.group[0]).toMatchObject({ netKg: 8_000, reference: "0004/KONTRAK/REK/XI/2026", contractKnown: false });
    expect(body.exceptions).toEqual([
      expect.objectContaining({ source: "APPROVAL", legacyId: 41, type: "NETTO_IN", status: "APPROVED", reportNo: "BA-REK/051", requestedAt: "2026-11-22T02:00:00.000Z", reportAt: "2026-11-22T03:00:00.000Z" }),
    ]);

    const [lone] = await database.query<{ id: number }>("select id::int as id from legacy_trips where legacy_id = 1");
    expect((await get(`/api/history/trips/${lone?.id}`)).json()).toMatchObject({ trip: { contractKnown: true }, group: [], exceptions: [] });
    const missing = await get("/api/history/trips/999999");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: "NOT_FOUND", message: "Riwayat lama tidak ditemukan." });
    expect((await get("/api/history/trips/abc")).statusCode).toBe(400);
  });

  it("flags each member of a multi-contract group on its own, and the trucks without a contract or reference", async () => {
    const { get, database } = await setup();
    const idOf = async (legacyId: number) => (await database.query<{ id: number }>("select id::int as id from legacy_trips where legacy_id = $1", [legacyId]))[0]?.id;
    const fourth = (await get(`/api/history/trips/${await idOf(4)}`)).json();
    expect(fourth.trip).toMatchObject({ legacyId: 4, contractKnown: false });
    expect(fourth.group).toEqual([expect.objectContaining({ legacyId: 3, contractKnown: true })]);
    expect((await get(`/api/history/trips/${await idOf(5)}`)).json().trip).toMatchObject({ reference: "777/SPK/LAIN/XI/2026", contractKnown: false });
    expect((await get(`/api/history/trips/${await idOf(6)}`)).json().trip).toMatchObject({ reference: null, contractKnown: null });
    expect((await get(`/api/history/trips/${await idOf(2)}`)).json().trip).toMatchObject({ direction: "OUT", contractKnown: null });
  });

  it("has no route that changes the archive", async () => {
    const { app, database } = await setup();
    const headers = await bearer(app, "reader");
    const [row] = await database.query<{ id: number }>("select id::int as id from legacy_trips where legacy_id = 1");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const url of ["/api/history/trips", `/api/history/trips/${row?.id}`]) {
        const response = await app.inject({ method, url, headers, payload: { netKg: 1 } });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    }
    expect(await database.query("select net_kg from legacy_trips where legacy_id = 1")).toEqual([{ net_kg: 25_005 }]);
  });

  it("is for staff with the reports module only", async () => {
    const { get, database } = await setup();
    const [row] = await database.query<{ id: number }>("select id::int as id from legacy_trips where legacy_id = 1");
    for (const url of ["/api/history/trips", `/api/history/trips/${row?.id}`]) {
      expect((await get(url, "other")).json().error.code, url).toBe("FORBIDDEN");
      expect((await get(url, "partner")).json().error.code, url).toBe("FORBIDDEN");
      expect((await get(url, "partner")).statusCode, url).toBe(403);
    }
  });
});
