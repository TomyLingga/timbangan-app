// The read routes the registration and DO forms use: quality parameters, products, and the three lookups a
// partner account fills the form with without browsing other companies' drivers, vehicles or partners.
import { describe, expect, it } from "vitest";
import { phase3App, seedDriver, seedVehicle } from "./helpers/fixtures.js";

const get = (call: Awaited<ReturnType<typeof phase3App>>["call"], url: string, username: string | null = "logistics") => call("GET", url, username);

describe("GET /api/quality-parameters", () => {
  it("lists the active parameters in their order, for accounts that may view registrations", async () => {
    const { call, database } = await phase3App();
    await database.query("insert into quality_parameters (code, name, unit, decimals, min_valid, max_valid, sort_order, is_active) values ('DOBI', 'DOBI', '-', 2, 0, 10, 0, false)");
    await database.query("update quality_parameters set sort_order = 0 where code = 'IMPURITIES'");
    const response = await get(call, "/api/quality-parameters", "qc");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { code: "IMPURITIES", name: "Impurities (kotoran)", unit: "%", decimals: 3, minValid: 0, maxValid: 5 },
        { code: "FFA", name: "FFA", unit: "%", decimals: 2, minValid: 0, maxValid: 20 },
        { code: "MOISTURE", name: "Moisture (kadar air)", unit: "%", decimals: 3, minValid: 0, maxValid: 5 },
        // the QC loading parameters of migration 0006 are switched off and not listed
      ],
    });
    expect((await get(call, "/api/quality-parameters", "pks1")).statusCode).toBe(200);
    expect((await get(call, "/api/quality-parameters", null)).statusCode).toBe(401);
  });
});

describe("GET /api/products", () => {
  it("lists active products by name with a search word and a limit", async () => {
    const { call, database, products } = await phase3App();
    await database.query("update products set is_active = false where id = $1", [products.packed]);
    const all = await get(call, "/api/products");
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({
      items: [
        { id: products.cpo, name: "Minyak Contoh Mentah", category: "CPO" },
        { id: products.olein, name: "Minyak Contoh Olahan", category: "BULK_LIQUID" },
      ],
      total: 2,
    });
    expect((await get(call, "/api/products?q=olah")).json()).toEqual({ items: [{ id: products.olein, name: "Minyak Contoh Olahan", category: "BULK_LIQUID" }], total: 1 });
    expect((await get(call, "/api/products?limit=1")).json()).toEqual({ items: [{ id: products.cpo, name: "Minyak Contoh Mentah", category: "CPO" }], total: 2 });
    expect((await get(call, "/api/products?q=%25")).json()).toEqual({ items: [], total: 0 });
  });

  it("is for staff accounts only, even a partner account that holds delivery orders", async () => {
    const { call } = await phase3App();
    expect((await get(call, "/api/products", "qc")).statusCode).toBe(200);
    const partner = await get(call, "/api/products", "angkut1");
    expect(partner.statusCode).toBe(403);
    expect(partner.json().error.code).toBe("FORBIDDEN");
  });
});

describe("GET /api/lookup/driver", () => {
  it("finds one driver by the whole licence number however it is written", async () => {
    const { call, database } = await phase3App();
    const id = await seedDriver(database, { name: "Supir Contoh", licence: "1234567890AB", status: "WARNING" });
    for (const typed of ["1234567890AB", "1234 5678 90ab", "1234-5678-90AB"]) {
      const response = await get(call, `/api/lookup/driver?licenceNo=${encodeURIComponent(typed)}`, "angkut1");
      expect(response.statusCode, typed).toBe(200);
      expect(response.json(), typed).toEqual({
        driver: {
          id, fullName: "Supir Contoh", licenceNo: "1234567890AB", licenceClass: "B2 UMUM", licenceValidUntil: "2028-01-31",
          licenceExpired: false, registryStatus: "WARNING", blocked: false, isActive: true,
        },
      });
    }
  });

  it("answers null for a prefix, a substring, a short, an empty or a missing licence number", async () => {
    const { call, database } = await phase3App();
    await seedDriver(database, { name: "Supir Contoh", licence: "1234567890AB" });
    for (const query of ["licenceNo=12345678", "licenceNo=567890AB", "licenceNo=34567890A", "licenceNo=1234567890ABC", "licenceNo=12", "licenceNo=1-2", "licenceNo=%25", "licenceNo=", ""]) {
      const response = await get(call, `/api/lookup/driver?${query}`, "pks1");
      expect(response.statusCode, query).toBe(200);
      expect(response.json(), query).toEqual({ driver: null });
    }
  });

  it("marks a blocked driver, an expired licence and an inactive driver", async () => {
    const { call, database } = await phase3App();
    const id = await seedDriver(database, { name: "Supir Lama", licence: "ABC123456", validUntil: "2026-11-19" });
    await database.query("insert into driver_blocks (driver_id, reason) values ($1, 'contoh')", [id]);
    await database.query("update drivers set is_active = false where id = $1", [id]);
    const driver = (await get(call, "/api/lookup/driver?licenceNo=abc123456")).json().driver;
    expect(driver).toMatchObject({ id, licenceExpired: true, blocked: true, isActive: false });

    // a lifted block and a block that ran out no longer count
    await database.query("update driver_blocks set lifted_at = now()");
    await database.query("insert into driver_blocks (driver_id, reason, blocked_until) values ($1, 'contoh', '2026-11-19T00:00:00Z')", [id]);
    expect((await get(call, "/api/lookup/driver?licenceNo=ABC123456")).json().driver.blocked).toBe(false);
  });
});

describe("GET /api/lookup/vehicle", () => {
  it("finds one vehicle by the whole plate however it is written", async () => {
    const { call, database, companies } = await phase3App();
    const id = await seedVehicle(database, { plate: "BK 1234 XY", type: "ISO_TANK", ownerId: companies.transporter2, capacityKg: 30000, verified: false, stnk: "2026-11-19", kir: "2026-01-01" });
    await database.query("update vehicles set tare_kg = 9000 where id = $1", [id]);
    for (const typed of ["BK1234XY", "bk 1234 xy", "BK-1234-XY"]) {
      const response = await get(call, `/api/lookup/vehicle?plate=${encodeURIComponent(typed)}`, "angkut1");
      expect(response.statusCode, typed).toBe(200);
      expect(response.json(), typed).toEqual({
        vehicle: {
          id, plateNo: "BK1234XY", plateDisplay: "BK 1234 XY", vehicleTypeCode: "ISO_TANK", needsContainerNo: true, capacityKg: 30000, tareKg: 9000,
          expired: ["STNK", "KIR"], verified: false, owner: { id: companies.transporter2, name: "PT Angkut Dua" }, isActive: true,
        },
      });
    }
  });

  it("answers null for a prefix, a substring, a short, an empty or a missing plate", async () => {
    const { call, database } = await phase3App();
    await seedVehicle(database, { plate: "BK 1234 XY" });
    for (const query of ["plate=BK1234", "plate=1234XY", "plate=K1234X", "plate=BK1234XYZ", "plate=BK", "plate=B-K", "plate=%25", "plate=", ""]) {
      const response = await get(call, `/api/lookup/vehicle?${query}`, "pks1");
      expect(response.statusCode, query).toBe(200);
      expect(response.json(), query).toEqual({ vehicle: null });
    }
  });

  it("answers a vehicle without an owner and an inactive vehicle", async () => {
    const { call, database } = await phase3App();
    const id = await seedVehicle(database, { plate: "BK 9 A", type: "BAK" });
    await database.query("update vehicles set is_active = false where id = $1", [id]);
    expect((await get(call, "/api/lookup/vehicle?plate=BK9A")).json().vehicle).toMatchObject({ id, needsContainerNo: false, owner: null, tareKg: null, expired: [], verified: true, isActive: false });
  });
});

describe("GET /api/lookup/transporters", () => {
  it("finds active transporters by part of the name, names and ids only", async () => {
    const { call, database, companies } = await phase3App();
    await database.query("insert into partners (name, code, address, is_transporter, is_active) values ('PT Angkut Tiga', 'T3', 'Jl. Contoh', true, false)");
    await database.query("update partners set code = 'T1', address = 'Jl. Contoh 2' where id = $1", [companies.transporter1]);
    const response = await get(call, "/api/lookup/transporters?q=aNgKuT", "pks1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { id: companies.transporter2, name: "PT Angkut Dua" },
        { id: companies.transporter1, name: "PT Angkut Satu" },
      ],
      total: 2,
    });
    expect((await get(call, "/api/lookup/transporters?q=angkut&limit=1", "angkut1")).json()).toEqual({ items: [{ id: companies.transporter2, name: "PT Angkut Dua" }], total: 2 });
    // suppliers and customers are not transporters
    expect((await get(call, "/api/lookup/transporters?q=sawit")).json()).toEqual({ items: [], total: 0 });
    expect((await get(call, "/api/lookup/transporters?q=%25%25")).json()).toEqual({ items: [], total: 0 });
  });

  it("answers an empty list for a search word shorter than 2 characters", async () => {
    const { call } = await phase3App();
    for (const query of ["q=a", "q=%20a%20", "q=", ""]) {
      expect((await get(call, `/api/lookup/transporters?${query}`, "angkut1")).json(), query).toEqual({ items: [], total: 0 });
    }
  });
});
