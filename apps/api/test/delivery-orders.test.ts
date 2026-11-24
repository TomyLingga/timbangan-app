import { describe, expect, it } from "vitest";
import { DESTINATION, phase3App, seedContract, seedDestination, siteCode } from "./helpers/fixtures.js";

async function setup() {
  const context = await phase3App();
  const { database, companies, products } = context;
  const sale = await seedContract(database, {
    no: "SC-001/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, qty: 500_000, tolerancePct: 0.25, customerPoNo: "PO-CONTOH-1",
  });
  const closedSale = await seedContract(database, { no: "SC-002/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, state: "CLOSED" });
  const purchase = await seedContract(database, { no: "PC-001/CONTOH", direction: "IN", partnerId: companies.supplier1, productId: products.cpo });
  const anywhere = await seedDestination(database, "Gudang Umum");
  const customerPlace = await seedDestination(database, "Gudang Pembeli Satu", companies.customer1);
  const otherPlace = await seedDestination(database, "Gudang Pembeli Dua", companies.customer2);
  const base = { doDate: "2026-11-20", qty: 120_000, ...DESTINATION, deliveryFrom: "2026-11-20", deliveryUntil: "2026-11-30" };
  const create = async (body: object, as = "logistics") => context.call("POST", "/api/delivery-orders", as, { ...base, ...body });
  const createOk = async (body: object) => {
    const response = await create(body);
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().deliveryOrder as { id: number; doNo: string; status: string };
  };
  const action = async (id: number, name: string, as = "logistics", payload: object = {}) => context.call("POST", `/api/delivery-orders/${id}/${name}`, as, payload);
  return { ...context, contracts: { sale, closedSale, purchase }, places: { anywhere, customerPlace, otherPlace }, base, create, createOk, action, site: await siteCode(database) };
}

describe("POST /api/delivery-orders", () => {
  it("fills partner, product, unit, contract number and customer PO from the sales contract and numbers the DO", async () => {
    const { create, contracts, companies, products, places, site } = await setup();
    const response = await create({ contractId: contracts.sale, transporterId: companies.transporter1, truckCount: 4, transportTerms: "FRANCO", remark: "catatan" });
    expect(response.statusCode).toBe(201);
    expect(response.json().deliveryOrder).toEqual({
      id: expect.any(Number),
      doNo: `001/DO/${site}/XI/2026`,
      doDate: "2026-11-20",
      status: "DRAFT",
      contract: { id: contracts.sale, contractNo: "SC-001/CONTOH" },
      customerPoNo: "PO-CONTOH-1",
      partner: { id: companies.customer1, name: "PT Pembeli Satu" },
      product: { id: products.olein, name: "Minyak Contoh Olahan", category: "BULK_LIQUID" },
      qty: 120000,
      uom: "kg",
      tolerancePct: 0.25,
      destination: { id: null, name: "Gudang Contoh", address: "Jl. Contoh 1", district: "Kec. Contoh", regency: "Kab. Contoh", province: "Prov. Contoh", location: null },
      deliveryFrom: "2026-11-20",
      deliveryUntil: "2026-11-30",
      transportTerms: "FRANCO",
      transporter: { id: companies.transporter1, name: "PT Angkut Satu" },
      truckCount: 4,
      truckCountBy: "ADMIN",
      qtyPlanned: 0,
      qtyRemaining: 120000,
      tripCount: 0,
      remark: "catatan",
      sentAt: null,
      acceptedAt: null,
    });
  });

  it("takes a typed number as it is, refuses a typed number in use, and skips a typed number when it numbers", async () => {
    const { create, createOk, site, companies, products } = await setup();
    const body = { partnerId: companies.customer1, productId: products.olein };
    const typed = await createOk({ ...body, doNo: ` 001/DO/${site}/XI/2026 ` });
    expect(typed.doNo).toBe(`001/DO/${site}/XI/2026`);
    const again = await create({ ...body, doNo: `001/DO/${site}/XI/2026` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("DUPLICATE");
    // the first number of the series is taken by the typed one
    expect((await createOk(body)).doNo).toBe(`002/DO/${site}/XI/2026`);
    expect((await createOk(body)).doNo).toBe(`003/DO/${site}/XI/2026`);
  });

  it("needs partner and product without a contract; refuses a contract that is not an open sales contract", async () => {
    const { create, contracts, companies, products } = await setup();
    const missing = await create({});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.fields.map((field: { field: string }) => field.field).sort()).toEqual(["partnerId", "productId"]);

    const ok = await create({ partnerId: companies.customer2, productId: products.packed });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().deliveryOrder).toMatchObject({ contract: null, uom: "karton", partner: { id: companies.customer2 }, product: { category: "PACKED" } });

    for (const contractId of [contracts.closedSale, contracts.purchase, 999_999]) {
      const refused = await create({ contractId });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.fields[0].field).toBe("contractId");
    }
  });

  it("checks the destination, the transporter, the dates and the quantity", async () => {
    const { create, companies, products } = await setup();
    const body = { partnerId: companies.customer1, productId: products.olein };
    const fieldOf = async (extra: object) => (await create({ ...body, ...extra })).json().error?.fields?.[0]?.field;
    expect(await fieldOf({ destName: " " })).toBe("destName");
    expect(await fieldOf({ destRegency: null })).toBe("destRegency");
    expect(await fieldOf({ transporterId: companies.supplier1 })).toBe("transporterId");
    expect(await fieldOf({ deliveryUntil: "2026-11-19" })).toBe("deliveryUntil");
    expect(await fieldOf({ qty: 0 })).toBe("qty");
    expect(await fieldOf({ truckCount: 501 })).toBe("truckCount");
  });

  it("is for logistics admins and system admins", async () => {
    const { create, companies, products } = await setup();
    const body = { partnerId: companies.customer1, productId: products.olein };
    expect((await create(body, "pos")).statusCode).toBe(403);
    expect((await create(body, "angkut1")).statusCode).toBe(403);
    expect((await create(body, "pks1")).statusCode).toBe(403);
  });
});

describe("delivery order life cycle", () => {
  it("is sent to a transporter, accepted by that transporter and closed", async () => {
    const { createOk, action, call, companies, products, clock } = await setup();
    const order = await createOk({ partnerId: companies.customer1, productId: products.olein });

    const noTransporter = await action(order.id, "send");
    expect(noTransporter.statusCode).toBe(400);
    expect(noTransporter.json().error.fields[0].field).toBe("transporterId");

    clock.advance(60_000);
    const sent = await action(order.id, "send", "logistics", { transporterId: companies.transporter1 });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().deliveryOrder).toMatchObject({ status: "SENT", transporter: { id: companies.transporter1 }, sentAt: "2026-11-20T03:01:00.000Z" });
    expect((await action(order.id, "send")).json().error.code).toBe("INVALID_STATE");
    expect((await action(order.id, "close")).json().error.code).toBe("INVALID_STATE");

    // another transporter does not see it; a supplier account may not accept anything
    expect((await action(order.id, "accept", "angkut2")).statusCode).toBe(404);
    expect((await action(order.id, "accept", "pks1")).statusCode).toBe(403);

    const accepted = await action(order.id, "accept", "angkut1", { truckCount: 3 });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().deliveryOrder).toMatchObject({ status: "ACCEPTED", truckCount: 3, truckCountBy: "TRANSPORTER", acceptedAt: "2026-11-20T03:01:00.000Z" });
    expect((await action(order.id, "accept", "angkut1")).json().error.code).toBe("INVALID_STATE");

    const closed = await action(order.id, "close");
    expect(closed.statusCode).toBe(200);
    expect(closed.json().deliveryOrder.status).toBe("CLOSED");
    expect((await action(order.id, "cancel", "logistics", { reason: "salah" })).json().error.code).toBe("INVALID_STATE");
    expect((await call("GET", `/api/delivery-orders/${order.id}`)).json().deliveryOrder.status).toBe("CLOSED");
  });

  it("keeps the truck count the admin gave when the transporter accepts; staff may accept for the transporter", async () => {
    const { createOk, action, companies, products } = await setup();
    const order = await createOk({ partnerId: companies.customer1, productId: products.olein, transporterId: companies.transporter1, truckCount: 2 });
    await action(order.id, "send");
    const accepted = await action(order.id, "accept", "logistics", { truckCount: 5 });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().deliveryOrder).toMatchObject({ status: "ACCEPTED", truckCount: 2, truckCountBy: "ADMIN" });
    expect((await action(order.id, "accept", "pos")).statusCode).toBe(403);
  });

  it("is cancelled with a reason from DRAFT, SENT or ACCEPTED", async () => {
    const { createOk, action, companies, products } = await setup();
    const order = await createOk({ partnerId: companies.customer1, productId: products.olein, transporterId: companies.transporter1 });
    expect((await action(order.id, "cancel")).statusCode).toBe(400);
    await action(order.id, "send");
    await action(order.id, "accept", "angkut1");
    const cancelled = await action(order.id, "cancel", "logistics", { reason: "pembeli batal" });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().deliveryOrder.status).toBe("CANCELLED");
    expect((await action(order.id, "cancel", "angkut1", { reason: "x" })).statusCode).toBe(403);
  });
});

describe("PATCH /api/delivery-orders/:id", () => {
  it("changes every field of a draft, and only the end date, truck count and remark once sent", async () => {
    const { createOk, action, call, companies, products, contracts } = await setup();
    const order = await createOk({ partnerId: companies.customer2, productId: products.packed });
    const edited = await call("PATCH", `/api/delivery-orders/${order.id}`, "logistics", { contractId: contracts.sale, qty: 90_000, transporterId: companies.transporter2 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().deliveryOrder).toMatchObject({ qty: 90000, contract: { id: contracts.sale }, partner: { id: companies.customer1 }, product: { id: products.olein }, uom: "kg", transporter: { id: companies.transporter2 } });

    await action(order.id, "send");
    const late = await call("PATCH", `/api/delivery-orders/${order.id}`, "logistics", { deliveryUntil: "2026-12-05", truckCount: 6, remark: "tambah" });
    expect(late.statusCode).toBe(200);
    expect(late.json().deliveryOrder).toMatchObject({ deliveryUntil: "2026-12-05", truckCount: 6, truckCountBy: "ADMIN", remark: "tambah" });
    const refused = await call("PATCH", `/api/delivery-orders/${order.id}`, "logistics", { qty: 1 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("INVALID_STATE");

    await action(order.id, "cancel", "logistics", { reason: "x" });
    expect((await call("PATCH", `/api/delivery-orders/${order.id}`, "logistics", { remark: "y" })).json().error.code).toBe("INVALID_STATE");
    expect((await call("PATCH", "/api/delivery-orders/999999", "logistics", { remark: "y" })).statusCode).toBe(404);
  });
});

describe("GET /api/delivery-orders", () => {
  it("shows staff every DO and a partner account only the DOs sent to its own company", async () => {
    const { createOk, action, call, companies, products } = await setup();
    const draft = await createOk({ doNo: "DO-A", partnerId: companies.customer1, productId: products.olein, transporterId: companies.transporter1 });
    const sent = await createOk({ doNo: "DO-B", partnerId: companies.customer1, productId: products.olein, transporterId: companies.transporter1 });
    const otherTransporter = await createOk({ doNo: "DO-C", partnerId: companies.customer2, productId: products.packed, transporterId: companies.transporter2 });
    await action(sent.id, "send");
    await action(otherTransporter.id, "send");

    const numbers = async (as: string, query = "") => {
      const body = (await call("GET", `/api/delivery-orders${query}`, as)).json();
      return { total: body.total, numbers: body.items.map((item: { doNo: string }) => item.doNo).sort() };
    };
    expect(await numbers("logistics")).toEqual({ total: 3, numbers: ["DO-A", "DO-B", "DO-C"] });
    expect(await numbers("qc")).toEqual({ total: 3, numbers: ["DO-A", "DO-B", "DO-C"] });
    expect(await numbers("logistics", "?status=DRAFT")).toEqual({ total: 1, numbers: ["DO-A"] });
    expect(await numbers("logistics", "?q=do-c")).toEqual({ total: 1, numbers: ["DO-C"] });
    expect(await numbers("logistics", "?q=pembeli dua")).toEqual({ total: 1, numbers: ["DO-C"] });
    expect(await numbers("angkut1")).toEqual({ total: 1, numbers: ["DO-B"] });
    expect(await numbers("angkut2")).toEqual({ total: 1, numbers: ["DO-C"] });
    // a supplier account does not get the DO module by default
    expect((await call("GET", "/api/delivery-orders", "pks1")).statusCode).toBe(403);

    expect((await call("GET", `/api/delivery-orders/${draft.id}`, "angkut1")).statusCode).toBe(404);
    expect((await call("GET", `/api/delivery-orders/${otherTransporter.id}`, "angkut1")).statusCode).toBe(404);
    const detail = await call("GET", `/api/delivery-orders/${sent.id}`, "angkut1");
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({ deliveryOrder: expect.objectContaining({ doNo: "DO-B", status: "SENT" }), trips: [], files: [] });
  });
});
