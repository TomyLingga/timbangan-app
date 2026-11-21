import { describe, expect, it } from "vitest";
import { FAKE_ACCOUNT, startFakeVcf } from "./helpers/fake-vcf.js";
import { phase3App, seedContract, seedDriver, seedVehicle, siteCode } from "./helpers/fixtures.js";
import { seedStaff } from "./helpers/users.js";

const TOKEN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

async function setup(env: Record<string, string> = {}) {
  const context = await phase3App(env);
  const { database, companies, products } = context;
  const contracts = {
    c1: await seedContract(database, { no: "PC-101/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: 100_000 }),
    c2: await seedContract(database, { no: "PC-102/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: 50_000, opening: 10_000 }),
    c3: await seedContract(database, { no: "PC-103/CONTOH", partnerId: companies.supplier1, productId: products.cpo }),
    goods: await seedContract(database, { no: "PC-104/CONTOH", partnerId: companies.supplier1, productId: products.olein }),
    closed: await seedContract(database, { no: "PC-105/CONTOH", partnerId: companies.supplier1, productId: products.cpo, state: "CLOSED" }),
    other: await seedContract(database, { no: "PC-201/CONTOH", partnerId: companies.supplier2, productId: products.cpo }),
    sale: await seedContract(database, { no: "SC-301/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein }),
  };
  const vehicles = {
    ok: await seedVehicle(database, { plate: "BK 1001 AA", ownerId: companies.transporter1 }),
    second: await seedVehicle(database, { plate: "BK 1002 AA", ownerId: companies.transporter1 }),
    papers: await seedVehicle(database, { plate: "BK 1003 AA", stnk: "2026-11-19", tax: "2026-01-01", kir: "2025-12-31" }),
    unverified: await seedVehicle(database, { plate: "BK 1004 AA", verified: false }),
    iso: await seedVehicle(database, { plate: "BK 1005 AA", type: "ISO_TANK" }),
  };
  const drivers = {
    ok: await seedDriver(database, { name: "Supir Contoh Satu", licence: "SIM0000001" }),
    second: await seedDriver(database, { name: "Supir Contoh Dua", licence: "SIM0000002" }),
    warning: await seedDriver(database, { name: "Supir Contoh Tiga", licence: "SIM0000003", status: "WARNING" }),
    blacklist: await seedDriver(database, { name: "Supir Contoh Empat", licence: "SIM0000004", status: "BLACKLIST" }),
    expired: await seedDriver(database, { name: "Supir Contoh Lima", licence: "SIM0000005", validUntil: "2026-11-19" }),
    unknown: await seedDriver(database, { name: "Supir Contoh Enam", licence: "SIM0000006", status: "UNKNOWN" }),
  };
  const truck = (over: object = {}) => ({ vehicle: { id: vehicles.ok }, driver: { id: drivers.ok }, plannedArrival: "2026-11-21", ...over });
  const incoming = (contractIds: number[], truckOver: object = {}, extra: object = {}) => ({
    direction: "IN",
    submit: true,
    plannedDate: "2026-11-21",
    allocations: contractIds.map((contractId) => ({ contractId })),
    trips: [truck(truckOver)],
    ...extra,
  });
  const register = async (body: object, as = "pks1") => context.call("POST", "/api/registrations", as, body);
  const registerOk = async (body: object, as = "pks1") => {
    const response = await register(body, as);
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().registration;
  };
  const count = async (table: string) => Number((await database.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0]?.n);
  return { ...context, contracts, vehicles, drivers, truck, incoming, register, registerOk, count, site: await siteCode(database) };
}

describe("incoming registration", () => {
  it("is created by a supplier for one truck with two contracts, approved at once without findings, and gets an SPJ", async () => {
    const { registerOk, incoming, contracts, companies, products, vehicles, drivers, ids, site } = await setup();
    const registration = await registerOk(
      incoming([contracts.c1, contracts.c3], {
        handoverNo: "PNY-1",
        letters: [
          { allocationSeq: 1, spbNo: "SPB-1", spbDate: "2026-11-19", originTicketNo: "TK-1", originGrossKg: 40_000, originTareKg: 12_000, originNetKg: 28_000, quality: { FFA: 3.5, MOISTURE: 0.15 } },
          { allocationSeq: 2, handoverNo: "PNY-2", spbNo: "SPB-2", originTareKg: 11_500, originNetKg: 2_000 },
        ],
      }),
    );
    expect(registration).toMatchObject({
      regNo: `REG/${site}/202611/00001`,
      direction: "IN",
      flowCode: "IN_CPO",
      status: "APPROVED",
      partner: { id: companies.supplier1, name: "PT Sawit Satu" },
      transporter: null,
      plannedDate: "2026-11-21",
      truckCount: 1,
      qtyTotal: 30000,
      uom: "kg",
      createdVia: "PORTAL",
      createdBy: { id: ids.pks1, fullName: "Partner pks1" },
      submittedAt: "2026-11-20T03:00:00.000Z",
      findings: [],
      allocations: [
        { seq: 1, contract: { id: contracts.c1, contractNo: "PC-101/CONTOH" }, deliveryOrder: null, contractNo: "PC-101/CONTOH", doNo: null, qtyPlanned: 28000, tolerancePct: 0, product: { id: products.cpo, name: "Minyak Contoh Mentah", category: "CPO" }, partner: { id: companies.supplier1, name: "PT Sawit Satu" } },
        { seq: 2, contract: { id: contracts.c3, contractNo: "PC-103/CONTOH" }, deliveryOrder: null, contractNo: "PC-103/CONTOH", doNo: null, qtyPlanned: 2000 },
      ],
    });
    const [trip] = registration.trips;
    expect(trip).toMatchObject({
      seq: 1,
      tripNo: null,
      status: "ISSUED",
      vehicle: { id: vehicles.ok, plateNo: "BK1001AA", plateDisplay: "BK 1001 AA", vehicleTypeCode: "TANGKI" },
      driver: { id: drivers.ok, fullName: "Supir Contoh Satu", licenceNo: "SIM0000001", registryStatus: "NORMAL" },
      plannedArrival: "2026-11-21",
      qtyPlanned: 30000,
      // the smallest tare above zero, the sum of the nets, and both added up
      docTareKg: 11500,
      docNetKg: 30000,
      docGrossKg: 41500,
      allocations: [
        { seq: 1, qtyPlanned: 28000, handoverNo: "PNY-1", spbNo: "SPB-1", spbDate: "2026-11-19", originTicketNo: "TK-1", originGrossKg: 40000, originTareKg: 12000, originNetKg: 28000, quality: { FFA: 3.5, MOISTURE: 0.15 } },
        { seq: 2, qtyPlanned: 2000, handoverNo: "PNY-2", spbNo: "SPB-2", spbDate: null, originGrossKg: null, originTareKg: 11500, originNetKg: 2000, quality: {} },
      ],
      card: null,
      checkedInAt: null,
    });
    expect(trip.spj).toEqual({
      id: expect.any(Number),
      spjNo: `SPJ/${site}/202611/00001`,
      barcodeToken: expect.stringMatching(TOKEN),
      issuedAt: "2026-11-20T03:00:00.000Z",
      validUntil: "2026-11-27T03:00:00.000Z",
      printCount: 0,
    });
  });

  it("leaves the truck figures empty when no origin net is given", async () => {
    const { registerOk, incoming, contracts } = await setup();
    const registration = await registerOk(incoming([contracts.c1], { letters: [{ allocationSeq: 1, originTareKg: 12_000 }] }));
    expect(registration.trips[0]).toMatchObject({ docTareKg: 12000, docNetKg: null, docGrossKg: null, qtyPlanned: null });
    expect(registration.qtyTotal).toBeNull();
  });

  it("saves a draft, replaces it with PUT, and submits it", async () => {
    const { registerOk, incoming, contracts, call, vehicles } = await setup();
    const draft = await registerOk(incoming([contracts.c1], {}, { submit: false }));
    expect(draft).toMatchObject({ status: "DRAFT", submittedAt: null, trips: [{ status: "DRAFT", spj: null }] });

    const replaced = await call("PUT", `/api/registrations/${draft.id}`, "pks1", incoming([contracts.c1, contracts.c3], { vehicle: { id: vehicles.second } }, { submit: false, remark: "ganti truk" }));
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().registration).toMatchObject({ id: draft.id, regNo: draft.regNo, status: "DRAFT", remark: "ganti truk", allocations: [{ seq: 1 }, { seq: 2 }], trips: [{ vehicle: { id: vehicles.second } }] });

    const submitted = await call("POST", `/api/registrations/${draft.id}/submit`, "pks1");
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().registration).toMatchObject({ status: "APPROVED", trips: [{ status: "ISSUED", spj: { spjNo: expect.any(String) } }] });
    expect((await call("POST", `/api/registrations/${draft.id}/submit`, "pks1")).json().error.code).toBe("INVALID_STATE");
    expect((await call("PUT", `/api/registrations/${draft.id}`, "pks1", incoming([contracts.c1]))).json().error.code).toBe("INVALID_STATE");
  });

  it("creates a vehicle and a driver in place; the driver is queued for the registry and sent at once", async () => {
    const vcf = await startFakeVcf();
    const { registerOk, incoming, contracts, companies, database, call } = await setup({ VCF_URL: vcf.url, VCF_USERNAME: FAKE_ACCOUNT.username, VCF_PASSWORD: FAKE_ACCOUNT.password });
    const registration = await registerOk(
      incoming([contracts.c1], {
        vehicle: { plateDisplay: "bk 9999 zz", vehicleTypeCode: "TANGKI", capacityKg: 30_000, stnkValidUntil: "2027-06-30" },
        driver: { licenceNo: "sim-9999-01", fullName: "Supir Baru", licenceClass: "B2 UMUM", licenceValidUntil: "2029-01-31", phone: "0800000000" },
      }, { transporterId: companies.transporter1 }),
    );
    // a vehicle a partner entered is not verified yet: that is a finding, so the registration waits for review
    expect(registration).toMatchObject({ status: "SUBMITTED", transporter: { id: companies.transporter1 }, findings: [{ code: "VEHICLE_UNVERIFIED", tripSeq: 1 }] });
    expect(registration.trips[0]).toMatchObject({ status: "READY", spj: null, vehicle: { plateNo: "BK9999ZZ", plateDisplay: "bk 9999 zz" }, driver: { licenceNo: "SIM999901", fullName: "Supir Baru" } });
    expect(await database.query("select owner_partner_id::int as owner, verified_at, capacity_kg from vehicles where plate_no = 'BK9999ZZ'")).toEqual([{ owner: companies.transporter1, verified_at: null, capacity_kg: 30000 }]);
    const [driver] = await database.query<{ registry_push: string; registry_status: string }>("select registry_push, registry_status from drivers where licence_no = 'SIM999901'");
    expect(driver?.registry_push).toBe("SENT");
    expect(vcf.paths()).toContain("POST /api/master/driver");

    // the same plate and licence again use the rows that exist
    const again = await registerOk(
      incoming([contracts.c3], {
        vehicle: { plateDisplay: "BK9999ZZ", vehicleTypeCode: "BOX" },
        driver: { licenceNo: "SIM999901", fullName: "Nama Lain", licenceClass: "B1", licenceValidUntil: "2030-01-01" },
      }),
    );
    expect(again.trips[0]).toMatchObject({ vehicle: { id: registration.trips[0].vehicle.id, vehicleTypeCode: "TANGKI" }, driver: { id: registration.trips[0].driver.id, fullName: "Supir Baru" } });
    expect(await database.query("select count(*)::int as n from drivers where licence_no = 'SIM999901'")).toEqual([{ n: 1 }]);
    void call;
  });

  it("marks a vehicle entered by staff as verified and queues the new driver without a registry account", async () => {
    const { registerOk, incoming, contracts, database } = await setup();
    const registration = await registerOk(
      incoming([contracts.c1], {
        vehicle: { plateDisplay: "BK 7777 ZZ", vehicleTypeCode: "TANGKI" },
        driver: { licenceNo: "SIM7777001", fullName: "Supir Pos", licenceClass: "B2 UMUM", licenceValidUntil: "2029-01-31" },
      }),
      "pos",
    );
    expect(registration).toMatchObject({ status: "APPROVED", createdVia: "OPERATOR", findings: [] });
    expect(await database.query("select (verified_at is not null) as verified from vehicles where plate_no = 'BK7777ZZ'")).toEqual([{ verified: true }]);
    expect(await database.query("select registry_push from drivers where licence_no = 'SIM7777001'")).toEqual([{ registry_push: "PENDING" }]);
  });
});

describe("incoming registration refusals", () => {
  it("refuses a blacklisted or locally blocked driver and saves nothing", async () => {
    const { register, incoming, contracts, drivers, database, count } = await setup();
    const blacklisted = await register(incoming([contracts.c1], { driver: { id: drivers.blacklist } }));
    expect(blacklisted.statusCode).toBe(409);
    expect(blacklisted.json().error.code).toBe("DRIVER_BLACKLISTED");

    await database.query("insert into driver_blocks (driver_id, reason) values ($1, 'contoh')", [drivers.second]);
    const blocked = await register(incoming([contracts.c1], { driver: { id: drivers.second } }));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("DRIVER_BLOCKED");
    expect(await count("registrations")).toBe(0);
    expect(await count("trips")).toBe(0);

    // a lifted block and a block that ran out no longer count
    await database.query("update driver_blocks set lifted_at = now()");
    await database.query("insert into driver_blocks (driver_id, reason, blocked_until) values ($1, 'contoh', '2026-11-19T00:00:00Z')", [drivers.second]);
    expect((await register(incoming([contracts.c1], { driver: { id: drivers.second } }))).statusCode).toBe(201);
  });

  it("refuses a contract that is not open, not a purchase contract, or of another company", async () => {
    const { register, incoming, contracts, count } = await setup();
    for (const contractId of [contracts.closed, contracts.sale, contracts.other, 999_999]) {
      const response = await register(incoming([contractId]));
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONTRACT_NOT_AVAILABLE");
    }
    expect(await count("registrations")).toBe(0);
  });

  it("refuses input the rules do not allow (400)", async () => {
    const { register, incoming, contracts, truck, vehicles, companies } = await setup();
    const fieldsOf = async (body: object) => {
      const response = await register(body);
      expect(response.statusCode).toBe(400);
      return response.json().error.fields.map((field: { field: string }) => field.field);
    };
    // the same contract twice, two flows in one truck, more contracts than the flow allows, two trucks
    expect(await fieldsOf(incoming([contracts.c1, contracts.c1]))).toEqual(["allocations"]);
    expect(await fieldsOf(incoming([contracts.c1, contracts.goods]))).toEqual(["allocations"]);
    expect(await fieldsOf(incoming([contracts.c1, contracts.c2, contracts.c3]))).toEqual(["allocations"]);
    expect(await fieldsOf({ ...incoming([contracts.c1]), trips: [truck(), truck({ vehicle: { id: vehicles.second } })] })).toEqual(["trips"]);
    expect(await fieldsOf(incoming([contracts.c1], { vehicle: { id: vehicles.iso } }))).toEqual(["trips.0.containerNo"]);
    expect(await fieldsOf(incoming([contracts.c1], { letters: [{ allocationSeq: 1, originGrossKg: 30_000, originTareKg: 10_000, originNetKg: 19_000 }] }))).toEqual(["trips.0.letters.0.originNetKg"]);
    expect(await fieldsOf(incoming([contracts.c1], { letters: [{ allocationSeq: 2 }] }))).toEqual(["trips.0.letters.0.allocationSeq"]);
    expect(await fieldsOf(incoming([contracts.c1], { letters: [{ allocationSeq: 1, quality: { SULFUR: 1 } }] }))).toEqual(["trips.0.letters.0.quality.SULFUR"]);
    expect(await fieldsOf(incoming([contracts.c1], { letters: [{ allocationSeq: 1, quality: { FFA: 25 } }] }))).toEqual(["trips.0.letters.0.quality.FFA"]);
    expect(await fieldsOf(incoming([contracts.c1], { vehicle: {} }))).toEqual(["trips.0.vehicle.plateDisplay", "trips.0.vehicle.vehicleTypeCode"]);
    expect(await fieldsOf(incoming([contracts.c1], { vehicle: { id: 999_999 } }))).toEqual(["trips.0.vehicle.id"]);
    expect(await fieldsOf(incoming([contracts.c1], { driver: { licenceNo: "SIM12345" } }))).toEqual(["trips.0.driver.fullName", "trips.0.driver.licenceClass", "trips.0.driver.licenceValidUntil"]);
    expect(await fieldsOf(incoming([contracts.c1], {}, { transporterId: companies.supplier1 }))).toEqual(["transporterId"]);
    // a container number makes the ISO tank acceptable
    expect((await register(incoming([contracts.c1], { vehicle: { id: vehicles.iso }, containerNo: "ABCU1234567" }))).statusCode).toBe(201);
  });

  it("is not open to transporter accounts or to staff without registrations:CREATE", async () => {
    const { register, incoming, contracts } = await setup();
    expect((await register(incoming([contracts.c1]), "angkut1")).statusCode).toBe(403);
    expect((await register(incoming([contracts.c1]), "qc")).statusCode).toBe(403);
  });
});

describe("incoming registration findings and review", () => {
  it("records each finding and keeps the registration for review", async () => {
    const { registerOk, incoming, contracts, vehicles, drivers } = await setup();
    const papers = await registerOk(incoming([contracts.c1], { vehicle: { id: vehicles.papers }, driver: { id: drivers.warning } }));
    expect(papers.status).toBe("SUBMITTED");
    expect(papers.trips[0].status).toBe("READY");
    expect(papers.findings.map((finding: { code: string }) => finding.code).sort()).toEqual(["DRIVER_WARNING", "KIR_EXPIRED", "STNK_EXPIRED", "TAX_EXPIRED"]);
    expect(papers.findings.every((finding: { tripSeq: number; message: string }) => finding.tripSeq === 1 && finding.message.length > 0)).toBe(true);

    const licence = await registerOk(incoming([contracts.c3], { vehicle: { id: vehicles.second }, driver: { id: drivers.expired } }));
    expect(licence.findings).toEqual([{ code: "LICENCE_EXPIRED", message: expect.any(String), tripSeq: 1 }]);
  });

  it("finds OVER_CONTRACT from the trucks that still hold the contract", async () => {
    const { registerOk, incoming, contracts, vehicles, drivers, call } = await setup();
    const letter = (net: number) => ({ letters: [{ allocationSeq: 1, originNetKg: net }] });
    // contract c2: 50 000 kg, 10 000 kg realised before the cut-over
    const first = await registerOk(incoming([contracts.c2], letter(30_000)), "logistics");
    expect(first.findings).toEqual([]);
    const cancelled = await registerOk(incoming([contracts.c2], { ...letter(30_000), vehicle: { id: vehicles.second }, driver: { id: drivers.second } }), "logistics");
    expect(cancelled.findings).toEqual([{ code: "OVER_CONTRACT", message: expect.any(String), tripSeq: 1, allocationSeq: 1 }]);
    expect((await call("POST", `/api/registrations/${cancelled.id}/cancel`, "logistics", { reason: "contoh" })).statusCode).toBe(200);

    expect((await registerOk(incoming([contracts.c2], letter(10_000)), "logistics")).findings).toEqual([]);
    expect((await registerOk(incoming([contracts.c2], letter(1)), "logistics")).findings.map((finding: { code: string }) => finding.code)).toEqual(["OVER_CONTRACT"]);
  });

  it("follows the driver registry policy: UNKNOWN set to WARN gives DRIVER_NOT_IN_REGISTRY", async () => {
    const { registerOk, incoming, contracts, drivers, database } = await setup();
    expect((await registerOk(incoming([contracts.c1], { driver: { id: drivers.unknown } }))).findings).toEqual([]);
    await database.query(`update settings set value = '{"BLACKLIST": "BLOCK", "WARNING": "WARN", "UNKNOWN": "WARN"}' where key = 'driver_registry_policy'`);
    const registration = await registerOk(incoming([contracts.c3], { driver: { id: drivers.unknown } }));
    expect(registration.findings).toEqual([{ code: "DRIVER_NOT_IN_REGISTRY", message: expect.any(String), tripSeq: 1 }]);
  });

  it("follows settings.registration_review: NEVER approves with findings, ALWAYS keeps every registration for review", async () => {
    const { registerOk, incoming, contracts, drivers, database } = await setup();
    await database.query(`update settings set value = '{"IN_CPO": "NEVER"}' where key = 'registration_review'`);
    const never = await registerOk(incoming([contracts.c1], { driver: { id: drivers.warning } }));
    expect(never).toMatchObject({ status: "APPROVED", findings: [{ code: "DRIVER_WARNING" }], trips: [{ status: "ISSUED" }] });
    await database.query(`update settings set value = '{"IN_CPO": "ALWAYS"}' where key = 'registration_review'`);
    const always = await registerOk(incoming([contracts.c3], { driver: { id: drivers.second } }));
    expect(always).toMatchObject({ status: "SUBMITTED", findings: [] });
  });

  it("is approved or rejected by a logistics admin", async () => {
    const { registerOk, incoming, contracts, drivers, call, clock, ids } = await setup();
    const waiting = await registerOk(incoming([contracts.c1], { driver: { id: drivers.warning } }));
    expect((await call("POST", `/api/registrations/${waiting.id}/approve`, "pks1")).statusCode).toBe(403);
    expect((await call("POST", `/api/registrations/${waiting.id}/approve`, "pos")).statusCode).toBe(403);
    clock.advance(5 * 60_000);
    const approved = await call("POST", `/api/registrations/${waiting.id}/approve`, "logistics", { note: "boleh" });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().registration).toMatchObject({ status: "APPROVED", reviewedAt: "2026-11-20T03:05:00.000Z", reviewNote: "boleh", trips: [{ status: "ISSUED", spj: { issuedAt: "2026-11-20T03:05:00.000Z" } }] });
    expect((await call("POST", `/api/registrations/${waiting.id}/approve`, "logistics")).json().error.code).toBe("INVALID_STATE");

    const other = await registerOk(incoming([contracts.c3], { driver: { id: drivers.warning } }));
    expect((await call("POST", `/api/registrations/${other.id}/reject`, "logistics", {})).statusCode).toBe(400);
    const rejected = await call("POST", `/api/registrations/${other.id}/reject`, "logistics", { note: "supir bermasalah" });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().registration).toMatchObject({ status: "REJECTED", reviewNote: "supir bermasalah", trips: [{ status: "CANCELLED", spj: null }] });
    void ids;
  });

  it("is cancelled by its creator or an admin until a truck has checked in", async () => {
    const { registerOk, incoming, contracts, call, database, vehicles, drivers } = await setup();
    const draft = await registerOk(incoming([contracts.c1], {}, { submit: false }));
    expect((await call("POST", `/api/registrations/${draft.id}/cancel`, "pks2", { reason: "x" })).statusCode).toBe(404);
    expect((await call("POST", `/api/registrations/${draft.id}/cancel`, "pos", { reason: "x" })).statusCode).toBe(403);
    expect((await call("POST", `/api/registrations/${draft.id}/cancel`, "pks1", {})).statusCode).toBe(400);
    const own = await call("POST", `/api/registrations/${draft.id}/cancel`, "pks1", { reason: "tidak jadi" });
    expect(own.statusCode).toBe(200);
    expect(own.json().registration).toMatchObject({ status: "CANCELLED", trips: [{ status: "CANCELLED" }] });

    const approved = await registerOk(incoming([contracts.c3], { vehicle: { id: vehicles.second }, driver: { id: drivers.second } }));
    const token = approved.trips[0].spj.barcodeToken;
    const byAdmin = await call("POST", `/api/registrations/${approved.id}/cancel`, "logistics", { reason: "salah kontrak" });
    expect(byAdmin.json().registration).toMatchObject({ status: "CANCELLED", trips: [{ status: "CANCELLED", spj: null }] });
    expect(await database.query("select revoke_reason from spj_documents where barcode_token = $1", [token])).toEqual([{ revoke_reason: "salah kontrak" }]);

    const arrived = await registerOk(incoming([contracts.c1]));
    await database.query("update trips set status = 'CHECKED_IN' where registration_id = $1", [arrived.id]);
    const late = await call("POST", `/api/registrations/${arrived.id}/cancel`, "logistics", { reason: "x" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("INVALID_STATE");
  });

  it("is cancelled, with its trips, by a staff member holding only registrations:CREATE when that member made it", async () => {
    const { registerOk, incoming, contracts, call, database } = await setup();
    await seedStaff(database, "clerk", { registrations: "CREATE" });
    await seedStaff(database, "clerk2", { registrations: "CREATE" });
    const mine = await registerOk(incoming([contracts.c1]), "clerk");
    expect(mine).toMatchObject({ status: "APPROVED", createdVia: "OPERATOR" });
    const trip = mine.trips[0];

    expect((await call("POST", `/api/trips/${trip.id}/cancel`, "clerk2", { reason: "x" })).statusCode).toBe(403);
    expect((await call("POST", `/api/trips/${trip.id}/cancel`, "clerk", { reason: "truk ganti" })).json().trip).toMatchObject({ status: "CANCELLED" });
    expect((await call("POST", `/api/registrations/${mine.id}/cancel`, "clerk2", { reason: "x" })).statusCode).toBe(403);
    expect((await call("POST", `/api/registrations/${mine.id}/cancel`, "clerk", { reason: "tidak jadi" })).json().registration.status).toBe("CANCELLED");
  });
});

describe("incoming registration visibility", () => {
  it("shows a supplier account only its own company's registrations and contracts", async () => {
    const { registerOk, incoming, contracts, call, vehicles, drivers } = await setup();
    const own = await registerOk(incoming([contracts.c1]));
    const forOther = await registerOk(incoming([contracts.other], { vehicle: { id: vehicles.second }, driver: { id: drivers.second } }), "logistics");
    expect(forOther).toMatchObject({ createdVia: "OPERATOR", partner: { name: "PT Sawit Dua" } });

    const list = async (as: string, query = "") => {
      const body = (await call("GET", `/api/registrations${query}`, as)).json();
      return { total: body.total, ids: body.items.map((item: { id: number }) => item.id) };
    };
    expect(await list("pks1")).toEqual({ total: 1, ids: [own.id] });
    expect(await list("pks2")).toEqual({ total: 1, ids: [forOther.id] });
    expect(await list("angkut1")).toEqual({ total: 0, ids: [] });
    expect((await list("logistics")).total).toBe(2);
    expect(await list("logistics", `?q=${encodeURIComponent(own.regNo)}`)).toEqual({ total: 1, ids: [own.id] });
    expect(await list("logistics", "?q=bk1002")).toEqual({ total: 1, ids: [forOther.id] });
    expect((await list("logistics", "?direction=OUT")).total).toBe(0);
    expect((await list("logistics", "?status=APPROVED")).total).toBe(2);

    const summary = (await call("GET", "/api/registrations", "pks1")).json().items[0];
    expect(summary).toMatchObject({ id: own.id, regNo: own.regNo, status: "APPROVED", findings: [], allocations: [{ seq: 1 }] });
    expect(summary.trips).toBeUndefined();

    expect((await call("GET", `/api/registrations/${own.id}`, "pks1")).json().registration.id).toBe(own.id);
    expect((await call("GET", `/api/registrations/${own.id}`, "pks2")).statusCode).toBe(404);
    expect((await call("GET", `/api/registrations/${own.id}`, "angkut1")).statusCode).toBe(404);

    const contractNumbers = (await call("GET", "/api/contracts?direction=IN", "pks2")).json().items.map((item: { contractNo: string }) => item.contractNo);
    expect(contractNumbers).toEqual(["PC-201/CONTOH"]);
  });
});
