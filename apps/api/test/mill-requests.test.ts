// Several mills (PKS) supplying one purchase contract (owner, 26 November 2026, and migration 0018): a contract with a
// trader of 10.000 t is delivered as 3.000 t by mill A, 2.000 t by mill B and 5.000 t by mill C. Each mill has its own
// account and gets its own shipment request; the registration keeps the contract's partner and carries the mill as
// "asal PKS". Mills are not in the ERP: the admin adds a mill together with its first account.
import { describe, expect, it } from "vitest";
import { phase3App, seedCompany, seedContract, seedDriver, seedVehicle } from "./helpers/fixtures.js";
import { multipart } from "./helpers/field.js";
import { bearer, PASSWORD, seedPartnerUser, seedStaff } from "./helpers/users.js";

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x20), Buffer.from("\n%%EOF\n")]);
const TON = 1000;

async function setup() {
  const ctx = await phase3App();
  const { app, database, call, companies, products } = ctx;
  await seedStaff(database, "inl", { shipment_requests: "EDIT", contracts: "VIEW", registrations: "EDIT", users: "EDIT" });
  const trader = await seedCompany(database, "PT Dagang Contoh", { supplier: true });
  const otherTrader = await seedCompany(database, "PT Niaga Contoh", { supplier: true });
  // a trader has no account (owner, 26 November 2026); this one exists only to show what the visibility rule allows
  await seedPartnerUser(database, "dagang", trader);

  /** A mill and its first account in one request, as the Pengguna page sends it. */
  const mill = async (username: string, name: string) => {
    const response = await call("POST", "/api/admin/users", "inl", { username, fullName: `Admin ${name}`, password: PASSWORD, newPartner: { name } });
    if (response.statusCode !== 201) throw new Error(response.body);
    return (response.json().user as { partner: { id: number } }).partner.id;
  };
  const millA = await mill("pksa", "PKS Contoh Andalas");
  const millB = await mill("pksb", "PKS Contoh Bukit");
  const millC = await mill("pksc", "PKS Contoh Cempaka");
  const millD = await mill("pksd", "PKS Contoh Damar");

  const contract = await seedContract(database, { no: "PC-TRD-01/CONTOH", partnerId: trader, productId: products.cpo, qty: 10_000 * TON, tolerancePct: 0.3 });
  const small = await seedContract(database, { no: "PC-TRD-02/CONTOH", partnerId: trader, productId: products.cpo, qty: 500 * TON });
  const foreign = await seedContract(database, { no: "PC-NGA-01/CONTOH", partnerId: otherTrader, productId: products.cpo, qty: 500 * TON });

  const uploadPdf = async () => {
    const body = multipart({ name: "kontrak.pdf", type: "application/pdf", bytes: PDF_BYTES });
    const response = await app.inject({ method: "POST", url: "/api/files", headers: { ...(await bearer(app, "inl")), ...body.headers }, payload: body.payload });
    if (response.statusCode !== 201) throw new Error(response.body);
    return (response.json() as { id: number }).id;
  };
  const create = (payload: object) => call("POST", "/api/shipment-requests", "inl", payload);
  /** A request to the mill with the contract PDF, sent. */
  const sendTo = async (supplierId: number, contractId: number, qtyPlanned?: number) => {
    const created = await create({ contractId, supplierId, ...(qtyPlanned === undefined ? {} : { qtyPlanned }) });
    if (created.statusCode !== 201) throw new Error(created.body);
    const id = created.json().shipmentRequest.id as number;
    await call("POST", `/api/shipment-requests/${id}/files`, "inl", { fileId: await uploadPdf() });
    const sent = await call("POST", `/api/shipment-requests/${id}/send`, "inl");
    if (sent.statusCode !== 200) throw new Error(sent.body);
    return id;
  };

  let plate = 0;
  /** One incoming truck with one letter per contract, each with this net. */
  const incoming = async (contractIds: number[], netKg = 30_000, extra: object = {}) => {
    plate++;
    const vehicle = await seedVehicle(database, { plate: `BK ${7100 + plate} PK` });
    const driver = await seedDriver(database, { name: `Supir Pabrik ${plate}`, licence: `SIMPKS${String(plate).padStart(4, "0")}` });
    return {
      direction: "IN",
      submit: false,
      plannedDate: "2026-11-21",
      allocations: contractIds.map((contractId) => ({ contractId })),
      trips: [
        {
          vehicle: { id: vehicle },
          driver: { id: driver },
          letters: contractIds.map((_, index) => ({ allocationSeq: index + 1, originGrossKg: netKg + 12_000, originTareKg: 12_000, originNetKg: netKg })),
        },
      ],
      ...extra,
    };
  };
  return { ...ctx, call, trader, otherTrader, millA, millB, millC, millD, contract, small, foreign, create, sendTo, incoming, companies };
}

describe("a mill and its first account", () => {
  it("are made together by the admin; a refused account leaves no partner behind", async () => {
    const { call, database, millA } = await setup();
    const shown = (await call("GET", "/api/admin/users?q=pksa", "inl")).json().items[0];
    expect(shown).toMatchObject({ kind: "PARTNER", username: "pksa", partner: { id: millA, name: "PKS Contoh Andalas" } });
    expect(Object.keys(shown.permissions).sort()).toEqual(["contracts", "drivers", "gps", "registrations", "shipment_requests", "vehicles"]);
    const [partner] = await database.query<{ erp_system: string | null; is_supplier: boolean }>("select erp_system, is_supplier from partners where id = $1", [millA]);
    expect(partner).toEqual({ erp_system: null, is_supplier: true });
    const actions = await database.query<{ action: string }>("select action from audit_log where action in ('PARTNER_CREATED', 'USER_CREATED') order by id limit 2");
    expect(actions.map((row) => row.action)).toEqual(["PARTNER_CREATED", "USER_CREATED"]);

    // a username in use: refused, and the new mill is not kept
    const taken = await call("POST", "/api/admin/users", "inl", { username: "PKSA", fullName: "Admin Baru", password: PASSWORD, newPartner: { name: "PKS Contoh Baru" } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe("USERNAME_TAKEN");
    expect(await database.query("select id from partners where name = 'PKS Contoh Baru'")).toEqual([]);
    // a mill name already there: refused with the partner to pick instead
    const again = await call("POST", "/api/admin/users", "inl", { username: "pksa2", fullName: "Admin Dua", password: PASSWORD, newPartner: { name: " pks contoh andalas " } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: "PARTNER_EXISTS", partnerId: millA });
    // a second account of the same mill
    const second = await call("POST", "/api/admin/users", "inl", { username: "pksa2", fullName: "Admin Dua", password: PASSWORD, partnerId: millA });
    expect(second.statusCode, second.body).toBe(201);
    // exactly one of the two
    expect((await call("POST", "/api/admin/users", "inl", { username: "pksx", fullName: "Admin X", password: PASSWORD })).statusCode).toBe(400);
    expect((await call("POST", "/api/admin/users", "inl", { username: "pksx", fullName: "Admin X", password: PASSWORD, partnerId: millA, newPartner: { name: "PKS X" } })).statusCode).toBe(400);
    expect((await call("POST", "/api/admin/users", "inl", { username: "pksx", fullName: "Admin X", password: "pendek", partnerId: millA })).statusCode).toBe(400);
    // the account of a mill signs in
    expect((await call("GET", "/api/me", "pksa2")).statusCode).toBe(200);
    // users EDIT is needed
    expect((await call("POST", "/api/admin/users", "logistics", { username: "pksy", fullName: "Admin Y", password: PASSWORD, partnerId: millA })).statusCode).toBe(403);
  });
});

describe("shipment requests to several mills on one contract", () => {
  it("sends 3.000, 2.000 and 5.000 to three mills, each sees only its own, and refuses more than the contract", async () => {
    const { call, create, sendTo, contract, trader, millA, millB, millC, millD, companies, database } = await setup();
    const a = await sendTo(millA, contract, 3_000 * TON);
    const b = await sendTo(millB, contract, 2_000 * TON);
    const c = await sendTo(millC, contract, 5_000 * TON);

    const forStaff = (await call("GET", `/api/shipment-requests?contractId=${contract}`, "inl")).json();
    expect(forStaff.total).toBe(3);
    expect(forStaff.items.map((item: { supplier: { id: number }; partner: { id: number }; contract: { qtyRequested: number } }) => [item.supplier.id, item.partner.id, item.contract.qtyRequested])).toEqual([
      [millC, trader, 10_000 * TON],
      [millB, trader, 10_000 * TON],
      [millA, trader, 10_000 * TON],
    ]);
    expect((await call("GET", `/api/shipment-requests?supplierId=${millB}`, "inl")).json().items.map((item: { id: number }) => item.id)).toEqual([b]);
    expect((await call("GET", "/api/shipment-requests?q=bukit", "inl")).json().items.map((item: { id: number }) => item.id)).toEqual([b]);

    // each mill: its own request, with the contract's partner and itself as the supplier, not what the others got
    for (const [username, id, supplier, qty] of [["pksa", a, millA, 3_000], ["pksb", b, millB, 2_000], ["pksc", c, millC, 5_000]] as const) {
      const list = (await call("GET", "/api/shipment-requests", username)).json();
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ id, partner: { id: trader, name: "PT Dagang Contoh" }, supplier: { id: supplier }, qtyPlanned: qty * TON, contract: { qtyRequested: null } });
    }
    expect((await call("GET", `/api/shipment-requests/${a}`, "pksb")).statusCode).toBe(404);
    // the notification went to the mill's account only
    const notified = await database.query<{ username: string }>(
      `select u.username from notification_deliveries d join users u on u.id = d.user_id join notifications n on n.id = d.notification_id
       where n.type = 'SHIPMENT_REQUEST_SENT' and d.channel = 'IN_APP' order by u.username`,
    );
    expect(notified.map((row) => row.username)).toEqual(["pksa", "pksb", "pksc"]);

    // the contract is fully asked for: a fourth mill gets nothing more
    const over = await create({ contractId: contract, supplierId: millD, qtyPlanned: 1 });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toEqual({
      code: "SHIPMENT_REQUEST_OVER_CONTRACT",
      message: "Permintaan 1 kg melebihi sisa kontrak PC-TRD-01/CONTOH: quantity kontrak 10000000 kg, sudah diminta 10000000 kg, sisa 0 kg.",
    });
    // raising a sent request above what is left is refused too; lowering it frees the difference
    expect((await call("PATCH", `/api/shipment-requests/${a}`, "inl", { qtyPlanned: 3_000 * TON + 1 })).json().error.code).toBe("SHIPMENT_REQUEST_OVER_CONTRACT");
    expect((await call("PATCH", `/api/shipment-requests/${a}`, "inl", { qtyPlanned: 2_500 * TON })).statusCode).toBe(200);
    const d = await create({ contractId: contract, supplierId: millD, qtyPlanned: 500 * TON });
    expect(d.statusCode, d.body).toBe(201);
    // a request without a quantity is not counted against the contract
    const noQty = await create({ contractId: contract, supplierId: companies.supplier1 });
    expect(noQty.statusCode, noQty.body).toBe(201);
    // a cancelled request no longer counts
    await call("POST", `/api/shipment-requests/${d.json().shipmentRequest.id}/cancel`, "inl", { reason: "Pabrik batal" });
    expect((await create({ contractId: contract, supplierId: companies.supplier2, qtyPlanned: 500 * TON })).statusCode).toBe(201);

    // one open request per contract and mill; the supplier must be a supplier
    const twice = await create({ contractId: contract, supplierId: millA });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("SHIPMENT_REQUEST_EXISTS");
    const customer = await create({ contractId: contract, supplierId: companies.customer1 });
    expect(customer.statusCode).toBe(400);
    expect(customer.json().error.fields).toEqual([{ field: "supplierId", message: "Supplier harus partner supplier yang aktif." }]);
  });

  it("lists to a mill the trader's contracts it was sent, with its own request", async () => {
    const { call, sendTo, contract, small, trader, millA, millB } = await setup();
    const a = await sendTo(millA, contract, 3_000 * TON);
    await sendTo(millB, small, 100 * TON);

    const listed = (await call("GET", "/api/contracts?direction=IN", "pksa")).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: contract,
      partner: { id: trader, name: "PT Dagang Contoh" },
      shipmentRequest: { id: a, status: "SENT", qtyPlanned: 3_000 * TON },
      requests: null,
    });
    expect((await call("GET", "/api/contracts?direction=IN&requestSent=true", "pksb")).json().items.map((item: { id: number }) => item.id)).toEqual([small]);
    // a mill without a request sees none of the trader's contracts
    expect((await call("GET", "/api/contracts?direction=IN", "pksc")).json().total).toBe(0);
    // staff see how much of each contract is asked for
    const staff = (await call("GET", "/api/contracts?direction=IN&q=PC-TRD", "inl")).json();
    expect(Object.fromEntries(staff.items.map((item: { id: number; requests: unknown }) => [item.id, item.requests]))).toEqual({
      [contract]: { open: 1, sent: 1, qtyRequested: 3_000 * TON },
      [small]: { open: 1, sent: 1, qtyRequested: 100 * TON },
    });
  });
});

describe("a mill registering trucks on a trader's contract", () => {
  it("registers with the mill as asal PKS, sees only its own, and the trader's view shows all on its contract", async () => {
    const { call, sendTo, incoming, contract, trader, millA, millB } = await setup();
    await sendTo(millA, contract, 3_000 * TON);
    await sendTo(millB, contract, 2_000 * TON);

    const byA = await call("POST", "/api/registrations", "pksa", await incoming([contract]));
    expect(byA.statusCode, byA.body).toBe(201);
    expect(byA.json().registration).toMatchObject({ partner: { id: trader, name: "PT Dagang Contoh" }, originPartner: { id: millA, name: "PKS Contoh Andalas" } });
    // what the mill sends as originPartnerId does not matter: it is its own company
    const byB = await call("POST", "/api/registrations", "pksb", await incoming([contract], 30_000, { originPartnerId: millA }));
    expect(byB.statusCode, byB.body).toBe(201);
    expect(byB.json().registration.originPartner).toEqual({ id: millB, name: "PKS Contoh Bukit" });
    const idA = byA.json().registration.id;
    const idB = byB.json().registration.id;

    const ids = async (username: string) => (await call("GET", "/api/registrations?direction=IN", username)).json().items.map((item: { id: number }) => item.id);
    expect(await ids("pksa")).toEqual([idA]);
    expect(await ids("pksb")).toEqual([idB]);
    expect((await call("GET", `/api/registrations/${idB}`, "pksa")).statusCode).toBe(404);
    expect((await call("POST", `/api/registrations/${idB}/cancel`, "pksa", { reason: "Bukan punya saya" })).statusCode).toBe(404);
    // the contract's partner reads both but changes neither
    expect((await ids("dagang")).sort()).toEqual([idA, idB].sort());
    expect((await call("POST", `/api/registrations/${idA}/cancel`, "dagang", { reason: "Coba" })).statusCode).toBe(404);
    // staff search by the mill's name
    expect((await call("GET", "/api/registrations?q=bukit", "inl")).json().items.map((item: { id: number }) => item.id)).toEqual([idB]);

    // a mill without a request on the contract is not let in
    const byD = await call("POST", "/api/registrations", "pksd", await incoming([contract]));
    expect(byD.statusCode).toBe(409);
    expect(byD.json().error.code).toBe("CONTRACT_NOT_AVAILABLE");
  });

  it("finds a mill's trucks above its request, counting only that mill's trucks", async () => {
    const { call, sendTo, incoming, small, millA, millB } = await setup();
    await sendTo(millA, small, 50 * TON);
    await sendTo(millB, small, 100 * TON);
    const codes = (response: { json: () => { registration: { findings: { code: string; message: string }[] } } }) => response.json().registration.findings;

    const first = await call("POST", "/api/registrations", "pksa", await incoming([small], 30_000));
    expect(codes(first)).toEqual([]);
    // mill B's truck does not use mill A's request
    expect(codes(await call("POST", "/api/registrations", "pksb", await incoming([small], 30_000)))).toEqual([]);
    const second = await call("POST", "/api/registrations", "pksa", await incoming([small], 30_000));
    expect(codes(second)).toEqual([
      { code: "OVER_REQUEST", message: "Netto surat 30000 kg melebihi sisa permintaan PKS Contoh Andalas pada kontrak PC-TRD-02/CONTOH (20000 kg).", tripSeq: 1, allocationSeq: 1 },
    ]);
    // sent, it waits for review like any registration with a finding
    const submitted = await call("POST", `/api/registrations/${second.json().registration.id}/submit`, "pksa");
    expect(submitted.json().registration.status).toBe("SUBMITTED");
  });

  it("takes several contracts in one truck only when they have one partner", async () => {
    const { call, sendTo, incoming, contract, small, foreign, millA } = await setup();
    for (const contractId of [contract, small, foreign]) await sendTo(millA, contractId, 100 * TON);

    const mixed = await call("POST", "/api/registrations", "pksa", await incoming([contract, foreign], 10_000));
    expect(mixed.statusCode).toBe(409);
    expect(mixed.json().error).toEqual({
      code: "CONTRACT_PARTNER_MISMATCH",
      message: "Kontrak dalam satu registrasi harus dari partner yang sama: PC-TRD-01/CONTOH (PT Dagang Contoh), PC-NGA-01/CONTOH (PT Niaga Contoh).",
    });
    // staff are held to the same rule
    expect((await call("POST", "/api/registrations", "inl", await incoming([contract, foreign], 10_000))).json().error.code).toBe("CONTRACT_PARTNER_MISMATCH");
    const same = await call("POST", "/api/registrations", "pksa", await incoming([contract, small], 10_000));
    expect(same.statusCode, same.body).toBe(201);
    expect(same.json().registration.originPartner.id).toBe(millA);
  });

  it("lets staff name the asal PKS, a supplier only", async () => {
    const { call, incoming, contract, millB, companies } = await setup();
    const named = await call("POST", "/api/registrations", "inl", await incoming([contract], 30_000, { originPartnerId: millB }));
    expect(named.statusCode, named.body).toBe(201);
    expect(named.json().registration.originPartner).toEqual({ id: millB, name: "PKS Contoh Bukit" });
    expect((await call("GET", `/api/registrations/${named.json().registration.id}`, "pksb")).statusCode).toBe(200);
    const notMill = await call("POST", "/api/registrations", "inl", await incoming([contract], 30_000, { originPartnerId: companies.transporter1 }));
    expect(notMill.statusCode).toBe(400);
    expect(notMill.json().error.fields).toEqual([{ field: "originPartnerId", message: "Asal PKS harus partner supplier." }]);
    // left out of a staff draft written again, it stays; null clears it
    const id = named.json().registration.id;
    const kept = await call("PUT", `/api/registrations/${id}`, "inl", await incoming([contract]));
    expect(kept.json().registration.originPartner).toEqual({ id: millB, name: "PKS Contoh Bukit" });
    const cleared = await call("PUT", `/api/registrations/${id}`, "inl", await incoming([contract], 30_000, { originPartnerId: null }));
    expect(cleared.json().registration.originPartner).toBeNull();
    // without an asal PKS the mill no longer sees the truck; with it, it did
    expect((await call("GET", `/api/registrations/${id}`, "pksb")).statusCode).toBe(404);
  });
});
