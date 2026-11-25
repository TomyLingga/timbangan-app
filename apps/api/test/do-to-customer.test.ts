// A DO sent to its own customer (owner's flow of 25 November 2026, outgoing step 2.1): the customer's accounts see
// it, accept it and register its trucks as their own transporter. The DO keeps the customer in transporter_id.
import { describe, expect, it } from "vitest";
import { DESTINATION, phase3App, seedContract, seedDriver, seedVehicle } from "./helpers/fixtures.js";
import { seedPartnerUser } from "./helpers/users.js";

async function setup() {
  const ctx = await phase3App();
  const { database, companies, products, call } = ctx;
  // made with the defaults of a customer company
  const pembeli1 = await seedPartnerUser(database, "pembeli1", companies.customer1);
  await seedPartnerUser(database, "pembeli2", companies.customer2);
  const sale = await seedContract(database, { no: "SC-701/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, qty: 500_000 });
  const draftDo = async (extra: object = {}) => {
    const response = await call("POST", "/api/delivery-orders", "logistics", { contractId: sale, doDate: "2026-11-20", qty: 60_000, ...DESTINATION, deliveryFrom: "2026-11-20", ...extra });
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().deliveryOrder as { id: number; doNo: string };
  };
  const vehicle = await seedVehicle(database, { plate: "BK 7101 CC", capacityKg: 32_000 });
  const driver = await seedDriver(database, { name: "Supir Pembeli", licence: "SIM0007101" });
  const outgoing = (deliveryOrderId: number) => ({
    direction: "OUT",
    submit: true,
    plannedDate: "2026-11-22",
    allocations: [{ deliveryOrderId }],
    trips: [{ vehicle: { id: vehicle }, driver: { id: driver }, plannedArrival: "2026-11-22" }],
  });
  return { ...ctx, pembeli1, draftDo, outgoing };
}

describe("a DO sent to its customer", () => {
  it("goes to the customer's accounts, who accept it and register its trucks as their own transporter", async () => {
    const { call, draftDo, outgoing, companies, database, pembeli1 } = await setup();
    // a transporter picked on the draft is replaced by the customer
    const order = await draftDo({ transporterId: companies.transporter1 });
    const sent = await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", { to: "CUSTOMER" });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().deliveryOrder).toMatchObject({
      status: "SENT",
      partner: { id: companies.customer1, name: "PT Pembeli Satu" },
      transporter: { id: companies.customer1, name: "PT Pembeli Satu" },
      sentTo: "CUSTOMER",
    });
    const notified = await database.query<{ user_id: number; body: string }>(
      "select d.user_id::int as user_id, n.body from notifications n join notification_deliveries d on d.notification_id = n.id where n.type = 'DO_SENT' and d.channel = 'IN_APP'",
    );
    expect(notified).toEqual([{ user_id: pembeli1, body: order.doNo }]);
    const audit = await database.query<{ after: unknown }>("select after from audit_log where action = 'DO_SENT' and entity_id = $1", [order.id]);
    expect(audit).toEqual([{ after: { status: "SENT", transporterId: companies.customer1, sentTo: "CUSTOMER" } }]);

    // the transporter and the other customer do not see it
    expect((await call("GET", `/api/delivery-orders/${order.id}`, "angkut1")).statusCode).toBe(404);
    expect((await call("GET", `/api/delivery-orders/${order.id}`, "pembeli2")).statusCode).toBe(404);
    expect((await call("GET", "/api/delivery-orders", "pembeli1")).json().items.map((item: { id: number }) => item.id)).toEqual([order.id]);

    const accepted = await call("POST", `/api/delivery-orders/${order.id}/accept`, "pembeli1", { truckCount: 1 });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().deliveryOrder).toMatchObject({ status: "ACCEPTED", truckCount: 1, truckCountBy: "TRANSPORTER" });

    expect((await call("POST", "/api/registrations", "angkut1", outgoing(order.id))).json().error.code).toBe("DO_NOT_AVAILABLE");
    const registered = await call("POST", "/api/registrations", "pembeli1", outgoing(order.id));
    expect(registered.statusCode, registered.body).toBe(201);
    const registration = registered.json().registration;
    expect(registration).toMatchObject({
      direction: "OUT",
      createdVia: "PORTAL",
      partner: { id: companies.customer1 },
      transporter: { id: companies.customer1, name: "PT Pembeli Satu" },
    });
    expect(await database.query("select transporter_id::int as transporter_id from trips where registration_id = $1", [registration.id])).toEqual([{ transporter_id: companies.customer1 }]);
    // the customer reads its own registration and its trucks
    expect((await call("GET", `/api/registrations/${registration.id}`, "pembeli1")).statusCode).toBe(200);
    expect((await call("GET", `/api/registrations/${registration.id}`, "pembeli2")).statusCode).toBe(404);
  });

  it("sends to a transporter as before, and refuses a transporter named for a customer send", async () => {
    const { call, draftDo, companies } = await setup();
    const toTransporter = await draftDo({ transporterId: companies.transporter1 });
    const sent = await call("POST", `/api/delivery-orders/${toTransporter.id}/send`, "logistics", {});
    expect(sent.json().deliveryOrder).toMatchObject({ status: "SENT", transporter: { id: companies.transporter1 }, sentTo: "TRANSPORTER" });

    const order = await draftDo();
    expect((await call("GET", `/api/delivery-orders/${order.id}`)).json().deliveryOrder.sentTo).toBeNull();
    const mixed = await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", { to: "CUSTOMER", transporterId: companies.transporter1 });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error.fields).toEqual([{ field: "transporterId", message: "DO untuk customer dikirim ke customer DO ini. Kosongkan transporter." }]);
    // a customer is not a transporter: naming it as one still fails
    const asTransporter = await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", { to: "TRANSPORTER", transporterId: companies.customer1 });
    expect(asTransporter.statusCode).toBe(400);
    expect((await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", { to: "OTHER" })).statusCode).toBe(400);
    expect((await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", { to: "CUSTOMER", transporterId: companies.customer1 })).json().deliveryOrder.sentTo).toBe("CUSTOMER");
  });
});
