import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { bearer, DESK, LOGISTICS, seedPartnerUser, seedStaff, TRANSPORTER, VIEWER } from "./helpers/users.js";

async function setup() {
  const context = await testApp();
  const { app, database } = context;
  const adminId = await seedStaff(database, "logistics", LOGISTICS);
  await seedStaff(database, "qc", VIEWER);
  await seedStaff(database, "pos", DESK);
  const partner = async (name: string, transporter: boolean) =>
    Number((await database.query<{ id: number }>("insert into partners (name, is_transporter) values ($1, $2) returning id::int as id", [name, transporter]))[0]?.id);
  const angkut = await partner("PT Angkut Satu", true);
  const lain = await partner("PT Angkut Dua", true);
  const pabrik = await partner("PT Pabrik", false);
  await seedPartnerUser(database, "angkut", angkut, TRANSPORTER);
  const call = async (method: "GET" | "POST" | "PATCH", url: string, username: string | null = "logistics", payload?: object) =>
    app.inject({ method, url, headers: username ? await bearer(app, username) : {}, ...(payload ? { payload } : {}) });
  const history = () =>
    database.query("select tare_kg, source, reason, changed_by::int as changed_by, changed_at from vehicle_tare_history order by id");
  return { ...context, adminId, angkut, lain, pabrik, call, history };
}

const full = (ownerPartnerId: number) => ({
  plateDisplay: " bk 8001 xx ",
  vehicleTypeCode: "TANGKI",
  ownerPartnerId,
  ownership: "MITRA",
  capacityKg: 30000,
  productionYear: 2019,
  tareKg: 15000,
  tareReason: "data awal",
  stnkValidUntil: "2026-11-19",
  taxValidUntil: "2026-11-20",
  kirValidUntil: "2027-03-31",
});

describe("GET /api/vehicle-types", () => {
  it("lists the vehicle types for any signed-in account", async () => {
    const { call } = await setup();
    const response = await call("GET", "/api/vehicle-types", "angkut");
    expect(response.statusCode).toBe(200);
    const { items } = response.json() as { items: { code: string }[] };
    expect(items.map((item) => item.code)).toEqual(["BAK", "BOX", "DUMP_TRUCK", "ISO_TANK", "KONTAINER", "TANGKI"]);
    expect(items[3]).toEqual({ code: "ISO_TANK", name: "ISO tank", isTank: true, needsContainerNo: true });
    expect((await call("GET", "/api/vehicle-types", null)).statusCode).toBe(401);
  });
});

describe("POST /api/vehicles", () => {
  it("creates a verified vehicle with the plate derived from what was typed, and records the first tare", async () => {
    const { call, database, adminId, angkut, history, clock } = await setup();
    const response = await call("POST", "/api/vehicles", "logistics", full(angkut));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      vehicle: {
        id: expect.any(Number),
        plateNo: "BK8001XX",
        plateDisplay: "bk 8001 xx",
        vehicleTypeCode: "TANGKI",
        owner: { id: angkut, name: "PT Angkut Satu" },
        ownership: "MITRA",
        capacityKg: 30000,
        productionYear: 2019,
        tareKg: 15000,
        stnkValidUntil: "2026-11-19",
        taxValidUntil: "2026-11-20",
        kirValidUntil: "2027-03-31",
        // the test clock stands on 20 November in Jakarta: only the STNK is past
        expired: ["STNK"],
        hasGps: false,
        isActive: true,
        verified: true,
      },
    });
    expect(await database.query("select created_by::int as created_by, verified_by::int as verified_by, verified_at from vehicles")).toEqual([
      { created_by: adminId, verified_by: adminId, verified_at: clock.now() },
    ]);
    expect(await history()).toEqual([{ tare_kg: 15000, source: "MANUAL", reason: "data awal", changed_by: adminId, changed_at: clock.now() }]);
  });

  it("needs only plate and type; without a tare there is no tare history", async () => {
    const { call, history } = await setup();
    const response = await call("POST", "/api/vehicles", "pos", { plateDisplay: "B 9 A", vehicleTypeCode: "BOX" });
    expect(response.statusCode).toBe(201);
    expect(response.json().vehicle).toMatchObject({ plateNo: "B9A", owner: null, ownership: null, tareKg: null, expired: [], verified: true });
    expect(await history()).toEqual([]);
  });

  it("answers 409 DUPLICATE for a plate that exists, however it is written", async () => {
    const { call, angkut } = await setup();
    await call("POST", "/api/vehicles", "logistics", full(angkut));
    const again = await call("POST", "/api/vehicles", "logistics", { plateDisplay: "BK-8001-XX", vehicleTypeCode: "BOX" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: { code: "DUPLICATE", message: "Plat BK8001XX sudah terdaftar." } });
  });

  it("answers 400 VALIDATION for a wrong plate, type, owner or value", async () => {
    const { call, pabrik, database } = await setup();
    const fields = async (payload: object) => {
      const response = await call("POST", "/api/vehicles", "logistics", payload);
      expect(response.statusCode).toBe(400);
      return response.json().error.fields;
    };
    expect(await fields({})).toEqual([
      { field: "plateDisplay", message: "Plat nomor wajib diisi." },
      { field: "vehicleTypeCode", message: "Jenis kendaraan wajib diisi." },
    ]);
    expect(await fields({ plateDisplay: "B-1", vehicleTypeCode: "BOX" })).toEqual([{ field: "plateDisplay", message: "Plat nomor harus 3 sampai 12 huruf atau angka." }]);
    expect(await fields({ plateDisplay: "B 1234 ABCDEFGH", vehicleTypeCode: "BOX" })).toEqual([{ field: "plateDisplay", message: "Plat nomor harus 3 sampai 12 huruf atau angka." }]);
    expect(await fields({ plateDisplay: "B 1 A", vehicleTypeCode: "ROKET" })).toEqual([{ field: "vehicleTypeCode", message: "Jenis kendaraan ROKET tidak ada." }]);
    expect(await fields({ plateDisplay: "B 1 A", vehicleTypeCode: "BOX", ownerPartnerId: pabrik })).toEqual([{ field: "ownerPartnerId", message: "Pemilik harus partner transporter." }]);
    expect(await fields({ plateDisplay: "B 1 A", vehicleTypeCode: "BOX", ownerPartnerId: 999999 })).toEqual([{ field: "ownerPartnerId", message: "Pemilik harus partner transporter." }]);
    expect(await fields({ plateDisplay: "B 1 A", vehicleTypeCode: "BOX", ownership: "SEWA", capacityKg: 0, productionYear: 1900, tareKg: -5, kirValidUntil: "31-03-2027" })).toEqual([
      { field: "ownership", message: "Kepemilikan harus SENDIRI atau MITRA." },
      { field: "capacityKg", message: "Daya angkut harus bilangan bulat lebih dari 0." },
      { field: "productionYear", message: "Tahun pembuatan harus antara 1970 dan 2100." },
      { field: "tareKg", message: "Tarra harus bilangan bulat lebih dari 0." },
      { field: "kirValidUntil", message: "Masa berlaku KIR harus berformat YYYY-MM-DD." },
    ]);
    expect(await database.query("select count(*)::int as n from vehicles")).toEqual([{ n: 0 }]);
  });

  it("is closed to other staff roles and to partner accounts", async () => {
    const { call, angkut, database } = await setup();
    expect((await call("POST", "/api/vehicles", "qc", full(angkut))).statusCode).toBe(403);
    expect((await call("POST", "/api/vehicles", "angkut", full(angkut))).statusCode).toBe(403);
    expect((await call("POST", "/api/vehicles", null, full(angkut))).statusCode).toBe(401);
    expect((await call("PATCH", "/api/vehicles/1", "angkut", { tareKg: 1 })).statusCode).toBe(403);
    expect(await database.query("select count(*)::int as n from vehicles")).toEqual([{ n: 0 }]);
  });
});

describe("PATCH /api/vehicles/:id", () => {
  async function withVehicle() {
    const context = await setup();
    const id = (await context.call("POST", "/api/vehicles", "logistics", full(context.angkut))).json().vehicle.id as number;
    return { ...context, id };
  }

  it("changes the given fields and writes a tare history row only when the tare changes", async () => {
    const { call, id, history, lain, clock, adminId } = await withVehicle();
    clock.advance(60_000);
    // the desk adds vehicles but does not change them
    expect((await call("PATCH", `/api/vehicles/${id}`, "pos", { tareKg: 15000 })).statusCode).toBe(403);
    const same = await call("PATCH", `/api/vehicles/${id}`, "logistics", { tareKg: 15000, ownerPartnerId: lain, kirValidUntil: null, capacityKg: null });
    expect(same.statusCode).toBe(200);
    expect(same.json().vehicle).toMatchObject({ tareKg: 15000, owner: { id: lain, name: "PT Angkut Dua" }, kirValidUntil: null, capacityKg: null, plateNo: "BK8001XX", ownership: "MITRA" });
    expect(await history()).toHaveLength(1);

    const changed = await call("PATCH", `/api/vehicles/${id}`, "logistics", { tareKg: 15120, tareReason: "timbang ulang kosong" });
    expect(changed.json().vehicle.tareKg).toBe(15120);
    expect((await history())[1]).toEqual({ tare_kg: 15120, source: "MANUAL", reason: "timbang ulang kosong", changed_by: adminId, changed_at: clock.now() });

    expect((await call("PATCH", `/api/vehicles/${id}`, "logistics", { tareKg: 15200 })).statusCode).toBe(200);
    expect((await history())[2]).toMatchObject({ tare_kg: 15200, reason: null });
    expect((await call("PATCH", `/api/vehicles/${id}`, "logistics", { isActive: false })).json().vehicle.isActive).toBe(false);
  });

  it("derives the plate again when it is retyped, and refuses a plate another vehicle has", async () => {
    const { call, id } = await withVehicle();
    await call("POST", "/api/vehicles", "logistics", { plateDisplay: "BK 7 Z", vehicleTypeCode: "BOX" });
    const renamed = await call("PATCH", `/api/vehicles/${id}`, "logistics", { plateDisplay: "BK 8002 XX" });
    expect(renamed.json().vehicle).toMatchObject({ plateNo: "BK8002XX", plateDisplay: "BK 8002 XX" });
    // the same plate written differently is not a duplicate of itself
    expect((await call("PATCH", `/api/vehicles/${id}`, "logistics", { plateDisplay: "BK8002XX" })).statusCode).toBe(200);
    const taken = await call("PATCH", `/api/vehicles/${id}`, "logistics", { plateDisplay: "bk 7 z" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe("DUPLICATE");
  });

  it("answers 404 for an unknown vehicle and 400 for wrong values", async () => {
    const { call, id, pabrik } = await withVehicle();
    expect((await call("PATCH", "/api/vehicles/999999", "logistics", { tareKg: 1 })).statusCode).toBe(404);
    expect((await call("PATCH", `/api/vehicles/${id}`, "logistics", { tareKg: null })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/vehicles/${id}`, "logistics", { vehicleTypeCode: "ROKET" })).json().error.fields).toEqual([
      { field: "vehicleTypeCode", message: "Jenis kendaraan ROKET tidak ada." },
    ]);
    expect((await call("PATCH", `/api/vehicles/${id}`, "logistics", { ownerPartnerId: pabrik })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/vehicles/${id}`, "logistics", { plateDisplay: "!!" })).statusCode).toBe(400);
  });
});

describe("GET /api/vehicles", () => {
  it("lists vehicles, finds a plate however it is typed, and shows a partner account only its own", async () => {
    const { call, angkut, lain } = await setup();
    await call("POST", "/api/vehicles", "logistics", full(angkut));
    await call("POST", "/api/vehicles", "logistics", { plateDisplay: "BK 8010 YY", vehicleTypeCode: "BOX", ownerPartnerId: lain, stnkValidUntil: "2026-01-01", taxValidUntil: "2026-01-01", kirValidUntil: "2026-01-01" });
    await call("POST", "/api/vehicles", "logistics", { plateDisplay: "B 9 A", vehicleTypeCode: "BAK" });

    const list = async (query: string, username = "qc") => (await call("GET", `/api/vehicles${query}`, username)).json() as { items: { plateNo: string; expired: string[] }[]; total: number };
    const all = await list("");
    expect(all.total).toBe(3);
    expect(all.items.map((item) => [item.plateNo, item.expired])).toEqual([
      ["B9A", []],
      ["BK8001XX", ["STNK"]],
      ["BK8010YY", ["STNK", "TAX", "KIR"]],
    ]);
    expect((await list("?q=bk%2080")).items.map((item) => item.plateNo)).toEqual(["BK8001XX", "BK8010YY"]);
    expect((await list("?q=8010-yy")).items.map((item) => item.plateNo)).toEqual(["BK8010YY"]);
    expect((await list("?limit=1")).items).toHaveLength(1);
    expect((await list("?limit=1")).total).toBe(3);

    const own = await list("", "angkut");
    expect(own.items.map((item) => item.plateNo)).toEqual(["BK8001XX"]);
    expect(own.total).toBe(1);
    expect((await list("?q=8010", "angkut")).items).toEqual([]);
    expect((await call("GET", "/api/vehicles", null)).statusCode).toBe(401);
  });
});

describe("POST /api/vehicles/:id/verify and /unverify", () => {
  /** A vehicle a partner entered (not verified), as a registration makes it. */
  async function withUnverified() {
    const context = await setup();
    const [row] = await context.database.query<{ id: number }>(
      "insert into vehicles (plate_no, plate_display, vehicle_type_code, owner_partner_id, tare_kg) values ('BK8101XA', 'BK 8101 XA', 'TANGKI', $1, 14000) returning id::int as id",
      [context.angkut],
    );
    const audit = () =>
      context.database.query("select user_id::int as user_id, action, entity_type, entity_id::int as entity_id, before, after from audit_log where entity_type = 'vehicle' order by id");
    return { ...context, id: Number(row?.id), audit };
  }

  it("marks a vehicle verified by the staff member and back, with an audit row each time", async () => {
    const { call, id, adminId, database, clock, audit } = await withUnverified();
    const verified = await call("POST", `/api/vehicles/${id}/verify`);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().vehicle).toMatchObject({ id, plateNo: "BK8101XA", verified: true });
    expect(await database.query("select verified_by::int as verified_by, verified_at from vehicles where id = $1", [id])).toEqual([{ verified_by: adminId, verified_at: clock.now() }]);
    expect((await call("GET", "/api/vehicles?q=8101")).json().items[0]).toMatchObject({ id, verified: true });

    const again = await call("POST", `/api/vehicles/${id}/verify`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toEqual({ code: "INVALID_STATE", message: "Kendaraan BK 8101 XA sudah diverifikasi." });

    const unverified = await call("POST", `/api/vehicles/${id}/unverify`);
    expect(unverified.statusCode).toBe(200);
    expect(unverified.json().vehicle).toMatchObject({ id, verified: false });
    expect(await database.query("select verified_by, verified_at from vehicles where id = $1", [id])).toEqual([{ verified_by: null, verified_at: null }]);
    expect((await call("POST", `/api/vehicles/${id}/unverify`)).json().error).toEqual({ code: "INVALID_STATE", message: "Kendaraan BK 8101 XA belum diverifikasi." });

    expect(await audit()).toEqual([
      { user_id: adminId, action: "VEHICLE_VERIFIED", entity_type: "vehicle", entity_id: id, before: { verified: false }, after: { verified: true } },
      { user_id: adminId, action: "VEHICLE_UNVERIFIED", entity_type: "vehicle", entity_id: id, before: { verified: true }, after: { verified: false } },
    ]);
  });

  it("answers 404 for an unknown vehicle and refuses other staff and partner accounts", async () => {
    const { call, id, audit } = await withUnverified();
    expect((await call("POST", "/api/vehicles/999999/verify")).statusCode).toBe(404);
    for (const username of ["qc", "pos", "angkut"]) {
      for (const action of ["verify", "unverify"]) {
        const response = await call("POST", `/api/vehicles/${id}/${action}`, username);
        expect(response.statusCode, `${username} ${action}`).toBe(403);
      }
    }
    expect(await audit()).toEqual([]);
  });
});
