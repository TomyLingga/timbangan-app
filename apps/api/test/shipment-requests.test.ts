// Shipment requests (0017): INL picks a purchase contract, attaches the contract PDF and sends the request to the
// supplier. A supplier account registers incoming trucks only on a contract with a SENT request; staff do not need one.
import { describe, expect, it } from "vitest";
import { phase3App, seedContract, seedDriver, seedVehicle } from "./helpers/fixtures.js";
import { multipart } from "./helpers/field.js";
import { bearer, seedPartnerUser, seedStaff } from "./helpers/users.js";

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x20), Buffer.from("\n%%EOF\n")]);

async function setup() {
  const ctx = await phase3App();
  const { app, database, companies, products } = ctx;
  await seedStaff(database, "inl", { shipment_requests: "EDIT", contracts: "VIEW", registrations: "EDIT" });
  await seedStaff(database, "pembuat", { shipment_requests: "CREATE" });
  await seedStaff(database, "pembaca", { shipment_requests: "VIEW" });
  // a second account of supplier 1, made after 0017: it gets the module from its company's defaults
  await seedPartnerUser(database, "pks1b", companies.supplier1);
  const headers = new Map<string, { authorization: string }>();
  const as = async (username: string) => {
    if (!headers.has(username)) headers.set(username, await bearer(app, username));
    return headers.get(username) as { authorization: string };
  };
  const request = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, username = "inl", payload?: object) =>
    app.inject({ method, url, headers: await as(username), ...(payload ? { payload } : {}) });
  const uploadPdf = async (username = "inl") => {
    const body = multipart({ name: "kontrak.pdf", type: "application/pdf", bytes: PDF_BYTES });
    const response = await app.inject({ method: "POST", url: "/api/files", headers: { ...(await as(username)), ...body.headers }, payload: body.payload });
    if (response.statusCode !== 201) throw new Error(response.body);
    return (response.json() as { id: number }).id;
  };
  const purchase = await seedContract(database, { no: "PC-801/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: 300_000, tolerancePct: 0.3 });
  const other = await seedContract(database, { no: "PC-802/CONTOH", partnerId: companies.supplier1, productId: products.cpo });
  const sale = await seedContract(database, { no: "SC-801/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein });
  const create = async (payload: object = { contractId: purchase }) => {
    const response = await request("POST", "/api/shipment-requests", "inl", payload);
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().shipmentRequest as { id: number; status: string };
  };
  /** A request on the contract with a PDF attached, sent to the supplier. */
  const sent = async (contractId = purchase) => {
    const created = await create({ contractId });
    await request("POST", `/api/shipment-requests/${created.id}/files`, "inl", { fileId: await uploadPdf() });
    const response = await request("POST", `/api/shipment-requests/${created.id}/send`);
    if (response.statusCode !== 200) throw new Error(response.body);
    return created.id;
  };
  const vehicle = await seedVehicle(database, { plate: "BK 8101 AA" });
  const driver = await seedDriver(database, { name: "Supir Permintaan", licence: "SIM0008101" });
  const incoming = (contractId: number, submit = true) => ({
    direction: "IN",
    submit,
    plannedDate: "2026-11-21",
    allocations: [{ contractId }],
    trips: [{ vehicle: { id: vehicle }, driver: { id: driver }, letters: [{ allocationSeq: 1, originGrossKg: 40_000, originTareKg: 10_000, originNetKg: 30_000 }] }],
  });
  const audit = async (id: number) =>
    (await database.query<{ action: string }>("select action from audit_log where entity_type = 'shipment_request' and entity_id = $1 order by id", [id])).map((row) => row.action);
  return { ...ctx, request, uploadPdf, purchase, other, sale, create, sent, incoming, audit };
}

describe("shipment requests", () => {
  it("makes a draft on an open purchase contract, one open request per contract", async () => {
    const { request, purchase, other, sale, companies, audit } = await setup();
    const created = await request("POST", "/api/shipment-requests", "inl", {
      contractId: purchase, qtyPlanned: 120_000, deliveryFrom: "2026-11-21", deliveryUntil: "2026-11-30", remark: "Kirim bertahap",
    });
    expect(created.statusCode, created.body).toBe(201);
    const shipmentRequest = created.json().shipmentRequest;
    expect(shipmentRequest).toMatchObject({
      status: "DRAFT",
      contract: { id: purchase, contractNo: "PC-801/CONTOH", state: "OPEN", qtyContract: 300000, uom: "kg", tolerancePct: 0.3 },
      product: { name: "Minyak Contoh Mentah", category: "CPO" },
      partner: { id: companies.supplier1, name: "PT Sawit Satu" },
      qtyPlanned: 120000,
      uom: "kg",
      deliveryFrom: "2026-11-21",
      deliveryUntil: "2026-11-30",
      remark: "Kirim bertahap",
      fileCount: 0,
      createdBy: { fullName: "Staff inl" },
      sentBy: null,
      sentAt: null,
      closedBy: null,
      cancelledBy: null,
      cancelReason: null,
    });

    const twice = await request("POST", "/api/shipment-requests", "inl", { contractId: purchase });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("SHIPMENT_REQUEST_EXISTS");
    const onSale = await request("POST", "/api/shipment-requests", "inl", { contractId: sale });
    expect(onSale.statusCode).toBe(400);
    expect(onSale.json().error.fields).toEqual([{ field: "contractId", message: "Kontrak beli tidak ditemukan atau tidak terbuka." }]);
    const window = await request("POST", "/api/shipment-requests", "inl", { contractId: sale, deliveryFrom: "2026-11-30", deliveryUntil: "2026-11-21" });
    expect(window.statusCode).toBe(400);

    // a supplier account reads only; a CREATE holder makes drafts but does not send them
    expect((await request("POST", "/api/shipment-requests", "pks1", { contractId: purchase })).statusCode).toBe(403);
    expect((await request("POST", "/api/shipment-requests", "pembaca", { contractId: purchase })).statusCode).toBe(403);
    const byCreator = await request("POST", "/api/shipment-requests", "pembuat", { contractId: other });
    expect(byCreator.statusCode, byCreator.body).toBe(201);
    expect((await request("POST", `/api/shipment-requests/${shipmentRequest.id}/send`, "pembuat")).statusCode).toBe(403);
    expect((await request("PATCH", `/api/shipment-requests/${shipmentRequest.id}`, "pembuat", { remark: "x" })).statusCode).toBe(403);
    expect(await audit(shipmentRequest.id)).toEqual(["SHIPMENT_REQUEST_CREATED"]);
  });

  it("is sent with the contract PDF, notifies the supplier's accounts, and shows only to that supplier", async () => {
    const { request, create, uploadPdf, purchase, database, ids, audit, clock } = await setup();
    const draft = await create();
    const noFile = await request("POST", `/api/shipment-requests/${draft.id}/send`);
    expect(noFile.statusCode).toBe(409);
    expect(noFile.json().error).toEqual({ code: "FILE_REQUIRED", message: "Lampirkan dokumen kontrak sebelum permintaan dikirim." });

    // a partner's upload is never attached; a staff PDF is
    const partnerFile = await uploadPdf("pks1");
    expect((await request("POST", `/api/shipment-requests/${draft.id}/files`, "inl", { fileId: partnerFile })).statusCode).toBe(400);
    const pdf = await uploadPdf();
    const attached = await request("POST", `/api/shipment-requests/${draft.id}/files`, "inl", { fileId: pdf, label: "Kontrak" });
    expect(attached.statusCode, attached.body).toBe(201);
    expect(attached.json().files).toEqual([
      { id: pdf, label: "Kontrak", originalName: "kontrak.pdf", mimeType: "application/pdf", sizeBytes: PDF_BYTES.length, addedAt: clock.now().toISOString(), addedBy: { id: expect.any(Number), fullName: "Staff inl" } },
    ]);
    expect((await request("POST", `/api/shipment-requests/${draft.id}/files`, "inl", { fileId: pdf })).statusCode).toBe(409);

    // before sending, the supplier sees nothing and cannot read the PDF
    expect((await request("GET", `/api/shipment-requests/${draft.id}`, "pks1")).statusCode).toBe(404);
    expect((await request("GET", "/api/shipment-requests", "pks1")).json()).toEqual({ items: [], total: 0 });
    expect((await request("GET", `/api/files/${pdf}`, "pks1")).statusCode).toBe(404);

    const sent = await request("POST", `/api/shipment-requests/${draft.id}/send`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().shipmentRequest).toMatchObject({ status: "SENT", sentBy: { fullName: "Staff inl" }, sentAt: clock.now().toISOString(), fileCount: 1 });
    expect((await request("POST", `/api/shipment-requests/${draft.id}/send`)).statusCode).toBe(409);

    const notified = await database.query<{ user_id: number; type: string; title: string; body: string; data: unknown }>(
      `select d.user_id::int as user_id, n.type, n.title, n.body, n.data from notifications n
       join notification_deliveries d on d.notification_id = n.id and d.channel = 'IN_APP' order by d.user_id`,
    );
    const pks1b = Number((await database.query<{ id: number }>("select id from users where username = 'pks1b'"))[0]?.id);
    expect(notified).toEqual(
      [ids.pks1, pks1b].sort((a, b) => a - b).map((userId) => ({
        user_id: userId,
        type: "SHIPMENT_REQUEST_SENT",
        title: "Permintaan pengiriman baru",
        body: "PC-801/CONTOH",
        data: { type: "SHIPMENT_REQUEST_SENT", shipmentRequestId: draft.id },
      })),
    );

    for (const supplier of ["pks1", "pks1b"]) {
      const list = (await request("GET", "/api/shipment-requests", supplier)).json();
      expect(list.total).toBe(1);
      expect(list.items[0]).toMatchObject({ id: draft.id, status: "SENT", contract: { id: purchase } });
      const detail = await request("GET", `/api/shipment-requests/${draft.id}`, supplier);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().files.map((file: { id: number }) => file.id)).toEqual([pdf]);
      expect((await request("GET", `/api/files/${pdf}`, supplier)).statusCode).toBe(200);
    }
    expect((await request("GET", `/api/shipment-requests/${draft.id}`, "pks2")).statusCode).toBe(404);
    expect((await request("GET", `/api/files/${pdf}`, "pks2")).statusCode).toBe(404);
    expect((await request("GET", "/api/shipment-requests", "pks2")).json()).toEqual({ items: [], total: 0 });
    // a transporter account has no access to the module
    expect((await request("GET", "/api/shipment-requests", "angkut1")).statusCode).toBe(403);
    // a staff reader sees every request
    expect((await request("GET", "/api/shipment-requests?status=SENT&q=pc-801", "pembaca")).json().total).toBe(1);

    // the last file of a sent request stays: add the new one first
    const last = await request("DELETE", `/api/shipment-requests/${draft.id}/files/${pdf}`);
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe("FILE_REQUIRED");
    const second = await uploadPdf();
    await request("POST", `/api/shipment-requests/${draft.id}/files`, "inl", { fileId: second });
    expect((await request("DELETE", `/api/shipment-requests/${draft.id}/files/${pdf}`)).json().files.map((file: { id: number }) => file.id)).toEqual([second]);
    expect(await audit(draft.id)).toEqual([
      "SHIPMENT_REQUEST_CREATED",
      "SHIPMENT_REQUEST_FILE_ADDED",
      "SHIPMENT_REQUEST_SENT",
      "SHIPMENT_REQUEST_FILE_ADDED",
      "SHIPMENT_REQUEST_FILE_REMOVED",
    ]);
  });

  it("changes a draft fully, a sent request only in quantity, end date and remark, and nothing after closing", async () => {
    const { request, create, uploadPdf, purchase, other, audit } = await setup();
    const draft = await create();
    const moved = await request("PATCH", `/api/shipment-requests/${draft.id}`, "inl", { contractId: other, deliveryFrom: "2026-11-22", qtyPlanned: 50_000 });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().shipmentRequest).toMatchObject({ contract: { id: other, contractNo: "PC-802/CONTOH" }, deliveryFrom: "2026-11-22", qtyPlanned: 50000 });
    // the first contract is free again
    const onFirst = await create({ contractId: purchase });
    expect((await request("PATCH", `/api/shipment-requests/${onFirst.id}`, "inl", { contractId: other })).json().error.code).toBe("SHIPMENT_REQUEST_EXISTS");
    expect((await request("PATCH", `/api/shipment-requests/${draft.id}`, "inl", { deliveryUntil: "2026-11-20" })).statusCode).toBe(400);

    await request("POST", `/api/shipment-requests/${draft.id}/files`, "inl", { fileId: await uploadPdf() });
    await request("POST", `/api/shipment-requests/${draft.id}/send`);
    const late = await request("PATCH", `/api/shipment-requests/${draft.id}`, "inl", { qtyPlanned: 70_000, deliveryUntil: "2026-12-05", remark: null });
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().shipmentRequest).toMatchObject({ qtyPlanned: 70000, deliveryUntil: "2026-12-05", remark: null });
    expect((await request("PATCH", `/api/shipment-requests/${draft.id}`, "inl", { deliveryFrom: "2026-11-25" })).statusCode).toBe(409);
    expect((await request("PATCH", `/api/shipment-requests/${draft.id}`, "pks1", { remark: "x" })).statusCode).toBe(403);

    const closed = await request("POST", `/api/shipment-requests/${draft.id}/close`);
    expect(closed.json().shipmentRequest).toMatchObject({ status: "CLOSED", closedBy: { fullName: "Staff inl" } });
    expect((await request("PATCH", `/api/shipment-requests/${draft.id}`, "inl", { remark: "x" })).statusCode).toBe(409);
    expect((await request("POST", `/api/shipment-requests/${draft.id}/cancel`, "inl", { reason: "Salah" })).statusCode).toBe(409);
    // a closed request stays readable by its supplier
    expect((await request("GET", `/api/shipment-requests/${draft.id}`, "pks1")).statusCode).toBe(200);
    // and the contract may get a new request
    expect((await request("POST", "/api/shipment-requests", "inl", { contractId: other })).statusCode).toBe(201);

    expect((await request("POST", `/api/shipment-requests/${onFirst.id}/cancel`, "inl", {})).statusCode).toBe(400);
    const cancelled = await request("POST", `/api/shipment-requests/${onFirst.id}/cancel`, "inl", { reason: "Kontrak diganti" });
    expect(cancelled.json().shipmentRequest).toMatchObject({ status: "CANCELLED", cancelReason: "Kontrak diganti", cancelledBy: { fullName: "Staff inl" } });
    expect(await audit(draft.id)).toEqual([
      "SHIPMENT_REQUEST_CREATED",
      "SHIPMENT_REQUEST_CHANGED",
      "SHIPMENT_REQUEST_FILE_ADDED",
      "SHIPMENT_REQUEST_SENT",
      "SHIPMENT_REQUEST_CHANGED",
      "SHIPMENT_REQUEST_CLOSED",
    ]);
  });
});

describe("registering incoming trucks against shipment requests", () => {
  it("lets a supplier register only on a contract with a SENT request; staff need none", async () => {
    const { call, request, sent, purchase, incoming } = await setup();
    const refused = await call("POST", "/api/registrations", "pks1", incoming(purchase));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual({
      code: "SHIPMENT_REQUEST_REQUIRED",
      message: "Kontrak PC-801/CONTOH belum dikirim INL ke perusahaan Anda. Truk hanya bisa didaftarkan untuk kontrak yang sudah dikirim.",
    });
    // a draft request is not enough
    const draft = (await request("POST", "/api/shipment-requests", "inl", { contractId: purchase })).json().shipmentRequest;
    expect((await call("POST", "/api/registrations", "pks1", incoming(purchase))).statusCode).toBe(409);
    await request("POST", `/api/shipment-requests/${draft.id}/cancel`, "inl", { reason: "Ulang" });

    // staff at the post register on the paper the driver brings
    const byStaff = await call("POST", "/api/registrations", "logistics", incoming(purchase));
    expect(byStaff.statusCode, byStaff.body).toBe(201);

    const id = await sent(purchase);
    const ok = await call("POST", "/api/registrations", "pks1", incoming(purchase, false));
    expect(ok.statusCode, ok.body).toBe(201);

    // once the request is closed, the draft can no longer be sent or written again
    await request("POST", `/api/shipment-requests/${id}/close`);
    const registrationId = ok.json().registration.id;
    const submit = await call("POST", `/api/registrations/${registrationId}/submit`, "pks1");
    expect(submit.statusCode).toBe(409);
    expect(submit.json().error.code).toBe("SHIPMENT_REQUEST_REQUIRED");
    const rewrite = await call("PUT", `/api/registrations/${registrationId}`, "pks1", incoming(purchase, true));
    expect(rewrite.json().error.code).toBe("SHIPMENT_REQUEST_REQUIRED");
    expect((await call("POST", "/api/registrations", "pks1", incoming(purchase))).statusCode).toBe(409);
  });

  it("tells in the contract list which contracts have a request sent", async () => {
    const { call, request, sent, create, purchase, other } = await setup();
    const sentId = await sent(purchase);
    const draft = await create({ contractId: other });

    const forSupplier = (await call("GET", "/api/contracts?direction=IN", "pks1")).json();
    const byNo = (list: { items: { contractNo: string; shipmentRequest: unknown }[] }) => Object.fromEntries(list.items.map((item) => [item.contractNo, item.shipmentRequest]));
    // the supplier does not see a draft
    expect(byNo(forSupplier)).toEqual({ "PC-801/CONTOH": { id: sentId, status: "SENT", sentAt: expect.any(String) }, "PC-802/CONTOH": null });
    const onlySent = (await call("GET", "/api/contracts?direction=IN&requestSent=true", "pks1")).json();
    expect(onlySent.total).toBe(1);
    expect(onlySent.items.map((item: { id: number }) => item.id)).toEqual([purchase]);
    expect((await call("GET", "/api/contracts?direction=IN&requestSent=false", "pks1")).json().items.map((item: { id: number }) => item.id)).toEqual([other]);

    const forStaff = (await request("GET", "/api/contracts?direction=IN", "inl")).json();
    expect(byNo(forStaff)).toEqual({
      "PC-801/CONTOH": { id: sentId, status: "SENT", sentAt: expect.any(String) },
      "PC-802/CONTOH": { id: draft.id, status: "DRAFT", sentAt: null },
    });
    expect((await call("GET", "/api/contracts?requestSent=maybe", "pks1")).statusCode).toBe(400);
  });
});
