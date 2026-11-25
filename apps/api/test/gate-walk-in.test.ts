// POST /api/gate/walk-in: the operator confirmed the proposal of a scanned document. One request registers the
// truck, attaches the scan, and checks the truck in with a card; a refusal leaves nothing behind.
import { describe, expect, it } from "vitest";
import { letterAnswer, orderAnswer } from "./helpers/fake-ocr.js";
import { FAKE_ACCOUNT, startFakeVcf } from "./helpers/fake-vcf.js";
import { multipart, PNG_BYTES } from "./helpers/field.js";
import { seedCard } from "./helpers/fixtures.js";
import { bearer, seedStaff } from "./helpers/users.js";
import { JPEG_BYTES, walkInApp } from "./helpers/walk-in.js";

type App = Awaited<ReturnType<typeof walkInApp>>;

/** What a refused walk-in must not leave: rows of the registration, of the check-in, or numbers taken. */
async function leftBehind({ count }: App) {
  return {
    registrations: await count("select count(*)::int as n from registrations"),
    trips: await count("select count(*)::int as n from trips"),
    tripFiles: await count("select count(*)::int as n from trip_files"),
    spj: await count("select count(*)::int as n from spj_documents"),
    cardAssignments: await count("select count(*)::int as n from card_assignments"),
    cardsInUse: await count("select count(*)::int as n from rfid_cards where status = 'IN_USE'"),
    vehicles: await count("select count(*)::int as n from vehicles"),
    drivers: await count("select count(*)::int as n from drivers"),
    numbers: await count("select coalesce(sum(last_no), 0)::int as n from document_counters"),
    audit: await count("select count(*)::int as n from audit_log where action <> 'DOCUMENT_SCANNED'"),
  };
}

describe("POST /api/gate/walk-in, incoming", () => {
  it("registers the truck of the confirmed proposal, keeps the scan with it, and checks it in with the card", async () => {
    const ctx = await walkInApp();
    const { scanOk, walkIn, database, app, ids, companies, contracts, vehicles, drivers, cards, clock } = ctx;
    const proposal = await scanOk("IN");
    clock.advance(60_000);
    // the truck stands at the post: a planned date from the request is not taken
    const response = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "ab:00:00:00:00:01", registration: { ...proposal.registration, plannedDate: "2026-12-31" } });
    expect(response.statusCode, response.body).toBe(201);
    const { state, message, registration, trip } = response.json();
    expect({ state, message }).toEqual({ state: "CHECKED_IN", message: null });
    expect(registration).toMatchObject({
      direction: "IN",
      flowCode: "IN_CPO",
      status: "APPROVED",
      createdVia: "SCAN",
      createdBy: { id: ids.pos },
      plannedDate: "2026-11-20",
      partner: { id: companies.supplier1 },
      transporter: { id: companies.transporter1 },
      findings: [],
      allocations: [{ seq: 1, contract: { id: contracts.main, contractNo: "0012/UJI/CPO-L/XI/2026" }, qtyPlanned: 28090 }],
      trips: [{ id: trip.id, status: "CHECKED_IN" }],
    });
    // the same answer as the check-in by SPJ gives
    expect(trip).toMatchObject({
      registrationId: registration.id,
      status: "CHECKED_IN",
      tripNo: "20261120-0001",
      checkedInAt: "2026-11-20T03:01:00.000Z",
      currentStep: "SEAL_CHECK",
      plannedArrival: "2026-11-20",
      vehicle: { id: vehicles.letter, plateNo: "BK5001EE" },
      driver: { id: drivers.letter, licenceNo: "SIMSURAT0001" },
      docGrossKg: 40120,
      docTareKg: 12030,
      docNetKg: 28090,
      allocations: [{ seq: 1, handoverNo: "OP-77/UJI", spbNo: "0456/MS/UJI/XI/2026", spbDate: "2026-11-19", originNetKg: 28090, quality: { FFA: 3.58, MOISTURE: 0.19, IMPURITIES: 0.019 } }],
      spj: { spjNo: expect.any(String), barcodeToken: expect.any(String) },
      card: { uid: "AB0000000001", label: "K-01" },
    });

    expect(await database.query("select trip_id::int as trip, file_id::int as file, label, added_by::int as by from trip_files")).toEqual([
      { trip: trip.id, file: proposal.scan.fileId, label: "SCAN_DOKUMEN", by: ids.pos },
    ]);
    expect(await database.query("select status from rfid_cards where id = $1", [cards.one])).toEqual([{ status: "IN_USE" }]);
    expect(await database.query("select card_id::int as card, assigned_by::int as by from card_assignments where trip_id = $1", [trip.id])).toEqual([{ card: cards.one, by: ids.pos }]);
    const steps = await database.query<{ step_code: string; status: string }>("select step_code, status from trip_steps where trip_id = $1 order by seq", [trip.id]);
    expect(steps.slice(0, 3).map((step) => `${step.step_code}:${step.status}`)).toEqual(["CHECK_IN:DONE", "SEAL_CHECK:READY", "WEIGH_1:PENDING"]);
    // the audit entries of the routes it stands for: the file linked to the truck, and the check-in
    expect(await database.query("select action, entity_type, entity_id::int as entity_id, user_id::int as by, after from audit_log where action <> 'DOCUMENT_SCANNED' order by id")).toEqual([
      { action: "TRIP_SCAN_ADDED", entity_type: "registration", entity_id: registration.id, by: ids.pos, after: { tripId: trip.id, fileId: proposal.scan.fileId } },
      { action: "TRIP_CHECKED_IN", entity_type: "trip", entity_id: trip.id, by: ids.pos, after: { status: "CHECKED_IN", cardUid: "AB0000000001" } },
    ]);
    // staff read the scan back as any other file
    const scan = await app.inject({ method: "GET", url: `/api/files/${proposal.scan.fileId}`, headers: await bearer(app, "logistics") });
    expect(scan.rawPayload).toEqual(JPEG_BYTES);

    // one scan, one registration
    const before = await leftBehind(ctx);
    const again = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000002", registration: { ...proposal.registration, trips: [{ vehicle: { id: vehicles.other }, driver: { id: drivers.other } }] } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toEqual({ code: "SCAN_ALREADY_USED", message: "Scan ini sudah dipakai untuk registrasi lain." });
    expect(await leftBehind(ctx)).toEqual(before);
  });

  it("creates the vehicle and the driver the letter names, as the registration route does for staff", async () => {
    const vcf = await startFakeVcf();
    const { scanOk, walkIn, ocr, database, companies, contracts } = await walkInApp({ VCF_URL: vcf.url, VCF_USERNAME: FAKE_ACCOUNT.username, VCF_PASSWORD: FAKE_ACCOUNT.password });
    ocr.answer(letterAnswer({ no_polisi: "BK 9090 ZZ", nama_supir: "ORANG BARU SEKALI", no_sim: "9988-7766-5544" }));
    const proposal = await scanOk("IN");
    expect(proposal.registration).toBeNull();
    const [truck] = proposal.draft.trips;
    // the operator adds what no letter carries: the kind of truck, and the class and validity of the licence
    const registration = {
      ...proposal.draft,
      trips: [{ ...truck, vehicle: { ...truck.vehicle, vehicleTypeCode: "TANGKI" }, driver: { ...truck.driver, licenceClass: "B2 UMUM", licenceValidUntil: "2029-01-31" } }],
    };
    const response = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      state: "CHECKED_IN",
      registration: { status: "APPROVED", findings: [], allocations: [{ contract: { id: contracts.main } }] },
      trip: { status: "CHECKED_IN", vehicle: { plateNo: "BK9090ZZ", plateDisplay: "BK 9090 ZZ", vehicleTypeCode: "TANGKI" }, driver: { fullName: "ORANG BARU SEKALI", licenceNo: "998877665544" } },
    });
    // a vehicle staff enter is verified at once and belongs to the transporter of the letter
    expect(await database.query("select owner_partner_id::int as owner, (verified_at is not null) as verified from vehicles where plate_no = 'BK9090ZZ'")).toEqual([
      { owner: companies.transporter1, verified: true },
    ]);
    // the new driver went to the registry after the registration was committed
    expect(await database.query("select registry_push, licence_class, home_partner_id::int as home from drivers where licence_no = '998877665544'")).toEqual([
      { registry_push: "SENT", licence_class: "B2 UMUM", home: companies.transporter1 },
    ]);
    expect(vcf.paths()).toContain("POST /api/master/driver");
  });
});

describe("POST /api/gate/walk-in, outgoing", () => {
  it("registers the truck the operator chose for the delivery order of the scan, with the quantity it loads", async () => {
    const ctx = await walkInApp();
    const { scanOk, walkIn, ocr, deliveryOrder, call, database, companies, vehicles, drivers } = ctx;
    const order = await deliveryOrder(250_000);
    ocr.answer(orderAnswer({ nomor_do: order.doNo }));
    const proposal = await scanOk("OUT");
    const filled = {
      ...proposal.draft,
      closeCargo: true,
      flexiBag: false,
      trips: [{ ...proposal.draft.trips[0], vehicle: { id: vehicles.letter }, driver: { id: drivers.letter } }],
    };
    // without a quantity the whole remainder of the DO would go on this one truck
    const before = await leftBehind(ctx);
    const open = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: filled });
    expect(open.statusCode).toBe(400);
    expect(open.json().error.fields).toEqual([{ field: "registration.allocations.0.qtyPlanned", message: "Isi quantity yang dimuat truk ini." }]);
    // the operator marks close cargo and flexi bag before a bulk truck goes in; unmarked, nothing is kept
    const unanswered = await walkIn({
      scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: { ...filled, closeCargo: undefined, allocations: [{ deliveryOrderId: order.id, qtyPlanned: 30_000 }] },
    });
    expect(unanswered.statusCode).toBe(400);
    expect(unanswered.json().error.fields).toEqual([{ field: "registration.closeCargo", message: "Tandai close cargo: ya atau tidak." }]);
    expect(await leftBehind(ctx)).toEqual(before);

    const response = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: { ...filled, allocations: [{ deliveryOrderId: order.id, qtyPlanned: 30_000 }] } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      state: "CHECKED_IN",
      registration: {
        direction: "OUT", flowCode: "OUT_BULK", status: "APPROVED", createdVia: "SCAN", qtyTotal: 30000, closeCargo: true, flexiBag: false, findings: [],
        partner: { id: companies.customer1 },
        transporter: { id: companies.transporter1 },
        allocations: [{ deliveryOrder: { id: order.id, doNo: order.doNo }, qtyPlanned: 30000 }],
      },
      trip: {
        status: "CHECKED_IN", direction: "OUT", qtyPlanned: 30000, plannedArrival: "2026-11-20", closeCargo: true, flexiBag: false,
        vehicle: { id: vehicles.letter }, driver: { id: drivers.letter }, card: { uid: "AB0000000001" },
      },
    });
    expect((await call("GET", `/api/delivery-orders/${order.id}`)).json().deliveryOrder).toMatchObject({ qtyPlanned: 30000, qtyRemaining: 220000 });
    expect(await database.query("select label from trip_files")).toEqual([{ label: "SCAN_DOKUMEN" }]);
    expect(await database.query("select close_cargo, flexi_bag from trips")).toEqual([{ close_cargo: true, flexi_bag: false }]);
  });
});

describe("POST /api/gate/check-in, close cargo and flexi bag", () => {
  it("has the post mark a bulk outgoing truck that the transporter registered without the two answers", async () => {
    const { call, deliveryOrder, database, vehicles, drivers } = await walkInApp();
    const order = await deliveryOrder(250_000);
    // the transporter no longer answers close cargo and flexi bag: the registration is sent without them
    const created = await call("POST", "/api/registrations", "angkut1", {
      direction: "OUT", submit: true, allocations: [{ deliveryOrderId: order.id, qtyPlanned: 30_000 }], trips: [{ vehicle: { id: vehicles.letter }, driver: { id: drivers.letter } }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const { registration } = created.json();
    expect(registration).toMatchObject({ status: "APPROVED", closeCargo: null, flexiBag: null });
    const token = registration.trips[0].spj.barcodeToken;
    expect((await call("GET", `/api/gate/spj/${token}`, "pos")).json().trip).toMatchObject({ flowCode: "OUT_BULK", closeCargo: null, flexiBag: null });

    const unmarked = await call("POST", "/api/gate/check-in", "pos", { token, cardUid: "AB0000000001", flexiBag: true });
    expect(unmarked.statusCode).toBe(400);
    expect(unmarked.json().error.fields).toEqual([{ field: "closeCargo", message: "Tandai close cargo: ya atau tidak." }]);
    expect(await database.query("select status from trips")).toEqual([{ status: "ISSUED" }]);

    const marked = await call("POST", "/api/gate/check-in", "pos", { token, cardUid: "AB0000000001", closeCargo: false, flexiBag: true });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().trip).toMatchObject({ status: "CHECKED_IN", closeCargo: false, flexiBag: true });
    expect(await database.query("select close_cargo, flexi_bag from trips")).toEqual([{ close_cargo: false, flexi_bag: true }]);
    expect(await database.query("select after->'closeCargo' as close_cargo, after->'flexiBag' as flexi_bag from audit_log where action = 'TRIP_CHECKED_IN'")).toEqual([
      { close_cargo: false, flexi_bag: true },
    ]);
  });
});

describe("POST /api/gate/walk-in, emergency", () => {
  it("lets only the holder of gate_emergency type a registration when the scan was not read, with a reason", async () => {
    const ctx = await walkInApp();
    const { scan, scanOk, walkIn, ocr, database } = ctx;
    await seedStaff(database, "darurat", { gate: "EDIT", registrations: "EDIT", gate_emergency: "VIEW" });
    // what the operator would send: the body of a read letter stands in for what is typed by hand
    const typed = (await scanOk("IN")).registration;
    ocr.answer({ detail: "Model YOLO belum dipasang." }, 503);
    const broken = await scan("IN");
    expect(broken.statusCode).toBe(502);
    const scanFileId = broken.json().error.scanFileId as number;
    expect(await database.query("select outcome, direction from gate_scans where file_id = $1", [scanFileId])).toEqual([{ outcome: "NOT_READ", direction: "IN" }]);

    const before = await leftBehind(ctx);
    const refused = await walkIn({ scanFileId, cardUid: "AB0000000001", registration: typed, emergencyReason: "Layanan baca dokumen mati" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toEqual({
      code: "EMERGENCY_ACCESS_REQUIRED",
      message: "Dokumen ini belum terbaca oleh layanan baca dokumen. Pindai lagi, atau minta petugas dengan akses registrasi darurat.",
    });
    const silent = await walkIn({ scanFileId, cardUid: "AB0000000001", registration: typed }, "darurat");
    expect(silent.statusCode).toBe(400);
    expect(silent.json().error.fields).toEqual([{ field: "emergencyReason", message: "Alasan registrasi darurat wajib diisi, 3 sampai 300 huruf." }]);
    expect(await leftBehind(ctx)).toEqual(before);

    const response = await walkIn({ scanFileId, cardUid: "AB0000000001", registration: typed, emergencyReason: "Layanan baca dokumen mati" }, "darurat");
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ state: "CHECKED_IN", emergency: true, registration: { status: "APPROVED", createdVia: "OPERATOR" }, trip: { status: "CHECKED_IN" } });
    expect(await database.query("select label from trip_files")).toEqual([{ label: "SCAN_DOKUMEN" }]);
    expect(await database.query("select after->>'cause' as cause, reason from audit_log where action = 'WALK_IN_EMERGENCY'")).toEqual([
      { cause: "NOT_READ", reason: "Layanan baca dokumen mati" },
    ]);
  });

  it("counts an unreadable scan and a walk-in without a scan as typed, and a scan of the other direction as wrong", async () => {
    const ctx = await walkInApp();
    const { scanOk, walkIn, ocr, database } = ctx;
    await seedStaff(database, "darurat", { gate: "EDIT", registrations: "EDIT", gate_emergency: "VIEW" });
    const read = await scanOk("IN");
    const typed = read.registration;
    const answer = letterAnswer();
    ocr.answer({ ...answer, yolo: { ...(answer.yolo as object), field_ditemukan: 5, field_total: 12 } });
    const unreadable = await scanOk("IN");
    expect(unreadable.unreadable).toBe(true);

    const before = await leftBehind(ctx);
    const onUnreadable = await walkIn({ scanFileId: unreadable.scan.fileId, cardUid: "AB0000000001", registration: typed });
    expect([onUnreadable.statusCode, onUnreadable.json().error.code]).toEqual([403, "EMERGENCY_ACCESS_REQUIRED"]);
    const withoutScan = await walkIn({ cardUid: "AB0000000001", registration: typed, emergencyReason: "Scanner rusak" });
    expect([withoutScan.statusCode, withoutScan.json().error.message]).toEqual([403, "Registrasi tanpa scan dokumen hanya untuk petugas dengan akses registrasi darurat."]);
    // a reason does not turn a read scan into an emergency, and a scan belongs to the direction it was read for
    const order = await scanOk("OUT");
    const otherWay = await walkIn({ scanFileId: order.scan.fileId, cardUid: "AB0000000001", registration: typed, emergencyReason: "Salah pindai" }, "darurat");
    expect(otherWay.statusCode).toBe(400);
    expect(otherWay.json().error.fields).toEqual([{ field: "scanFileId", message: "Scan ini dipindai untuk arah yang lain." }]);
    expect(await leftBehind(ctx)).toEqual(before);

    const response = await walkIn({ cardUid: "AB0000000001", registration: typed, emergencyReason: "Scanner rusak" }, "darurat");
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ state: "CHECKED_IN", emergency: true, registration: { createdVia: "OPERATOR" } });
    expect(await database.query("select count(*)::int as n from trip_files")).toEqual([{ n: 0 }]);
    expect(await database.query("select after->>'cause' as cause, reason from audit_log where action = 'WALK_IN_EMERGENCY'")).toEqual([{ cause: "NO_SCAN", reason: "Scanner rusak" }]);
  });
});

describe("POST /api/gate/walk-in, refusals", () => {
  it("leaves nothing behind when a registration check refuses, and the scan can be used again", async () => {
    const ctx = await walkInApp();
    const { scanOk, walkIn, database, contracts, drivers } = ctx;
    const proposal = await scanOk("IN");
    const before = await leftBehind(ctx);
    const [truck] = proposal.registration.trips;
    // a new vehicle in the same request, so a row written before the refusal would show
    const blacklisted = { ...proposal.registration, trips: [{ ...truck, vehicle: { plateDisplay: "BK 9191 ZZ", vehicleTypeCode: "TANGKI" }, driver: { id: drivers.blacklist } }] };
    const refused = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: blacklisted });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual({ code: "DRIVER_BLACKLISTED", message: "Supir Supir Surat Empat masuk daftar hitam VCF." });
    expect(await leftBehind(ctx)).toEqual(before);
    expect(await database.query("select count(*)::int as n from vehicles where plate_no = 'BK9191ZZ'")).toEqual([{ n: 0 }]);

    // the contract was closed between the scan and the confirmation
    await database.query("update erp_contracts set state = 'CLOSED' where id = $1", [contracts.main]);
    const closed = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: proposal.registration });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe("CONTRACT_NOT_AVAILABLE");
    await database.query("update erp_contracts set state = 'OPEN' where id = $1", [contracts.main]);

    // what the registration service says about a field is told with the path of the walk-in body
    const unknown = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: { ...proposal.registration, trips: [{ ...truck, vehicle: { id: 999_999 } }] } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.fields).toEqual([{ field: "registration.trips.0.vehicle.id", message: "Kendaraan tidak ditemukan." }]);
    const figures = { ...truck, letters: [{ ...truck.letters[0], originNetKg: 28_091 }] };
    const wrongNet = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: { ...proposal.registration, trips: [figures] } });
    expect(wrongNet.json().error.fields).toEqual([{ field: "registration.trips.0.letters.0.originNetKg", message: "Netto asal harus sama dengan bruto dikurangi tarra." }]);
    expect(await leftBehind(ctx)).toEqual(before);

    // the scan was never attached, so the corrected confirmation goes through
    const accepted = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: proposal.registration });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({ state: "CHECKED_IN", registration: { regNo: expect.stringMatching(/\/00001$/) }, trip: { tripNo: "20261120-0001" } });
  });

  it("leaves no registration behind when the check-in itself refuses", async () => {
    const ctx = await walkInApp();
    const { scanOk, walkIn, database, vehicles, drivers } = ctx;
    await seedCard(database, "AB0000000009", "K-09", "LOST");
    const first = await scanOk("IN");
    const before = await leftBehind(ctx);
    const send = (scanFileId: number, cardUid: string, registration: object) => walkIn({ scanFileId, cardUid, registration });
    const codeOf = async (response: Promise<{ statusCode: number; json: () => { error: { code: string } } }>) => {
      const answer = await response;
      expect(answer.statusCode).toBe(409);
      return answer.json().error.code;
    };
    expect(await codeOf(send(first.scan.fileId, "FFFFFFFF", first.registration))).toBe("CARD_UNKNOWN");
    expect(await codeOf(send(first.scan.fileId, "AB0000000009", first.registration))).toBe("CARD_NOT_AVAILABLE");
    expect(await leftBehind(ctx)).toEqual(before);

    expect((await send(first.scan.fileId, "AB0000000001", first.registration)).statusCode).toBe(201);
    const inside = await leftBehind(ctx);
    expect(inside).toMatchObject({ registrations: 1, trips: 1, cardAssignments: 1, cardsInUse: 1 });

    // the next truck: the card of the first, then the first truck itself, then its driver
    const second = await scanOk("IN");
    const [truck] = second.registration.trips;
    const withTruck = (vehicle: number, driver: number) => ({ ...second.registration, trips: [{ ...truck, vehicle: { id: vehicle }, driver: { id: driver } }] });
    expect(await codeOf(send(second.scan.fileId, "AB0000000001", withTruck(vehicles.other, drivers.other)))).toBe("CARD_IN_USE");
    expect(await codeOf(send(second.scan.fileId, "AB0000000002", withTruck(vehicles.letter, drivers.other)))).toBe("VEHICLE_INSIDE");
    expect(await codeOf(send(second.scan.fileId, "AB0000000002", withTruck(vehicles.other, drivers.letter)))).toBe("DRIVER_INSIDE");
    expect(await leftBehind(ctx)).toEqual(inside);
    expect((await send(second.scan.fileId, "AB0000000002", withTruck(vehicles.other, drivers.other))).json()).toMatchObject({ state: "CHECKED_IN", trip: { tripNo: "20261120-0002" } });
  });

  it("refuses a body that is not a walk-in, and a scan that is not one", async () => {
    const ctx = await walkInApp();
    const { scanOk, walkIn, app, vehicles, drivers } = ctx;
    const proposal = await scanOk("IN");
    const before = await leftBehind(ctx);
    const fieldsOf = async (body: object) => {
      const response = await walkIn(body);
      expect(response.statusCode, response.body).toBe(400);
      return response.json().error.fields;
    };
    const base = { scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: proposal.registration };
    expect(await fieldsOf({ ...base, registration: { ...proposal.registration, submit: false } })).toEqual([
      { field: "registration.submit", message: "Registrasi di pos selalu langsung dikirim (submit: true)." },
    ]);
    const twoTrucks = [proposal.registration.trips[0], { vehicle: { id: vehicles.other }, driver: { id: drivers.other } }];
    expect(await fieldsOf({ ...base, registration: { ...proposal.registration, trips: twoTrucks } })).toEqual([{ field: "registration.trips", message: "Registrasi di pos berisi tepat satu truk." }]);
    expect(await fieldsOf({ ...base, cardUid: "bukan-hex" })).toEqual([{ field: "cardUid", message: "UID kartu harus 8 sampai 20 digit heksadesimal." }]);
    expect(await fieldsOf({ ...base, registration: { ...proposal.registration, allocations: [] } })).toEqual([{ field: "registration.allocations", message: "Pilih minimal satu kontrak atau DO." }]);
    expect(await fieldsOf({ ...base, scanFileId: 999_999 })).toEqual([{ field: "scanFileId", message: "Scan dokumen tidak ditemukan." }]);

    // a photo uploaded through POST /api/files is not a scanned document
    const upload = multipart({ bytes: PNG_BYTES });
    const photo = await app.inject({ method: "POST", url: "/api/files", headers: { ...(await bearer(app, "pos")), ...upload.headers }, payload: upload.payload });
    expect(photo.statusCode).toBe(201);
    expect(await fieldsOf({ ...base, scanFileId: photo.json().id })).toEqual([{ field: "scanFileId", message: "Scan dokumen tidak ditemukan." }]);
    expect(await leftBehind(ctx)).toEqual(before);
  });
});

describe("POST /api/gate/walk-in, review", () => {
  it("says plainly that the registration waits for review, and does not check the truck in", async () => {
    const ctx = await walkInApp();
    const { scanOk, walkIn, call, database, drivers, cards } = ctx;
    const proposal = await scanOk("IN");
    const [truck] = proposal.registration.trips;
    // a driver with a warning in the registry is a finding, and a finding sends the registration to logistics
    const response = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: { ...proposal.registration, trips: [{ ...truck, driver: { id: drivers.warning } }] } });
    expect(response.statusCode, response.body).toBe(201);
    const { state, message, registration, trip } = response.json();
    expect({ state, message, trip }).toEqual({ state: "REVIEW", message: "Registrasi menunggu tinjauan logistik. Truk belum check-in dan kartu belum dipakai.", trip: null });
    expect(registration).toMatchObject({
      status: "SUBMITTED",
      createdVia: "SCAN",
      findings: [{ code: "DRIVER_WARNING", tripSeq: 1 }],
      trips: [{ status: "READY", spj: null, card: null, tripNo: null, checkedInAt: null }],
    });
    expect(await leftBehind(ctx)).toMatchObject({ registrations: 1, trips: 1, tripFiles: 1, spj: 0, cardAssignments: 0, cardsInUse: 0 });
    expect(await database.query("select status from rfid_cards where id = $1", [cards.one])).toEqual([{ status: "AVAILABLE" }]);
    expect(await database.query("select action from audit_log where action <> 'DOCUMENT_SCANNED'")).toEqual([{ action: "TRIP_SCAN_ADDED" }]);

    // logistics approves: the SPJ is issued and the desk checks the truck in the usual way
    const approved = (await call("POST", `/api/registrations/${registration.id}/approve`, "logistics", {})).json().registration;
    const checkedIn = await call("POST", "/api/gate/check-in", "pos", { token: approved.trips[0].spj.barcodeToken, cardUid: "AB0000000001" });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);
    expect(checkedIn.json().trip).toMatchObject({ id: registration.trips[0].id, status: "CHECKED_IN", card: { uid: "AB0000000001" } });
  });

  it("sends a new driver to review when the site's policy warns about drivers the registry does not know", async () => {
    const { scanOk, walkIn, ocr, database } = await walkInApp();
    await database.query(`update settings set value = '{"BLACKLIST": "BLOCK", "WARNING": "WARN", "UNKNOWN": "WARN"}' where key = 'driver_registry_policy'`);
    ocr.answer(letterAnswer({ nama_supir: "ORANG BARU SEKALI", no_sim: "9988-7766-5544" }));
    const proposal = await scanOk("IN");
    const [truck] = proposal.draft.trips;
    const registration = { ...proposal.draft, trips: [{ ...truck, driver: { ...truck.driver, licenceClass: "B2 UMUM", licenceValidUntil: "2029-01-31" } }] };
    const response = await walkIn({ scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ state: "REVIEW", trip: null, registration: { status: "SUBMITTED", findings: [{ code: "DRIVER_NOT_IN_REGISTRY" }] } });
  });
});

describe("POST /api/gate/walk-in, permissions", () => {
  it("needs gate CREATE and registrations CREATE together, and a staff account", async () => {
    const ctx = await walkInApp();
    const { scanOk, walkIn, database } = ctx;
    await seedStaff(database, "gerbang", { gate: "EDIT" });
    await seedStaff(database, "daftar", { registrations: "EDIT" });
    const proposal = await scanOk("IN");
    const body = { scanFileId: proposal.scan.fileId, cardUid: "AB0000000001", registration: proposal.registration };
    const before = await leftBehind(ctx);
    expect((await walkIn(body, null)).statusCode).toBe(401);
    for (const username of ["gerbang", "daftar", "qc", "pks1", "angkut1"]) {
      const response = await walkIn(body, username);
      expect(response.statusCode, username).toBe(403);
      expect(response.json().error.code, username).toBe("FORBIDDEN");
    }
    expect(await leftBehind(ctx)).toEqual(before);
    expect((await walkIn(body, "pos")).statusCode).toBe(201);
  });
});
