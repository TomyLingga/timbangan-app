import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { bearer, DESK, LOGISTICS, seedPartner, seedPartnerUser, seedStaff, SUPPLIER } from "./helpers/users.js";

async function setup() {
  const context = await testApp();
  const { app, database } = context;
  await seedStaff(database, "logistics", LOGISTICS);
  await seedStaff(database, "pos", DESK);
  await seedPartnerUser(database, "pks", await seedPartner(database, "PT Contoh Sawit"), SUPPLIER);
  const call = async (method: "GET" | "POST" | "PATCH", url: string, username = "logistics", payload?: object) =>
    app.inject({ method, url, headers: await bearer(app, username), ...(payload ? { payload } : {}) });
  return { ...context, call };
}

describe("RFID cards", () => {
  it("registers a card with its UID normalised to upper-case hexadecimal without separators", async () => {
    const { call } = await setup();
    const response = await call("POST", "/api/rfid-cards", "logistics", { uid: "04:a1-b2 c3d4", label: "K-001", note: "baru" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ card: { id: expect.any(Number), uid: "04A1B2C3D4", label: "K-001", status: "AVAILABLE", note: "baru", trip: null } });
  });

  it("refuses a UID that is not 8 to 20 hexadecimal digits, and a UID that exists (409 DUPLICATE)", async () => {
    const { call } = await setup();
    const bad = await call("POST", "/api/rfid-cards", "logistics", { uid: "XYZ12345" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: "VALIDATION", fields: [{ field: "uid" }] });
    expect((await call("POST", "/api/rfid-cards", "logistics", { uid: "1234567" })).statusCode).toBe(400);

    expect((await call("POST", "/api/rfid-cards", "logistics", { uid: "0011AABB" })).statusCode).toBe(201);
    const again = await call("POST", "/api/rfid-cards", "logistics", { uid: "00:11:aa:bb" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("DUPLICATE");
  });

  it("lists cards with search, status filter and the trip a card is bound to", async () => {
    const { call, database } = await setup();
    for (const [uid, label] of [["AA000001", "K-001"], ["AA000002", "K-002"], ["BB000003", "K-003"]] as const) {
      await call("POST", "/api/rfid-cards", "logistics", { uid, label });
    }
    const third = (await call("GET", "/api/rfid-cards?q=k-003")).json().items[0];
    await call("PATCH", `/api/rfid-cards/${third.id}`, "logistics", { status: "LOST" });

    const all = (await call("GET", "/api/rfid-cards")).json();
    expect(all.total).toBe(3);
    expect(all.items.map((card: { uid: string }) => card.uid)).toEqual(["AA000001", "AA000002", "BB000003"]);
    expect((await call("GET", "/api/rfid-cards?q=aa00")).json().total).toBe(2);
    expect((await call("GET", "/api/rfid-cards?status=LOST")).json().items.map((card: { label: string }) => card.label)).toEqual(["K-003"]);
    expect((await call("GET", "/api/rfid-cards?limit=1")).json()).toMatchObject({ total: 3, items: [{ uid: "AA000001" }] });
    expect((await call("GET", "/api/rfid-cards?status=BROKEN")).statusCode).toBe(400);
    void database;
  });

  it("changes label, note and status, but never to IN_USE and never while the card is bound to a trip", async () => {
    const { call, database } = await setup();
    const card = (await call("POST", "/api/rfid-cards", "logistics", { uid: "CC000001" })).json().card;
    const changed = await call("PATCH", `/api/rfid-cards/${card.id}`, "logistics", { label: "K-9", note: "retak", status: "RETIRED" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().card).toMatchObject({ label: "K-9", note: "retak", status: "RETIRED" });
    expect((await call("PATCH", `/api/rfid-cards/${card.id}`, "logistics", { status: "IN_USE" })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/rfid-cards/999999", "logistics", { label: "x" })).statusCode).toBe(404);

    // a card bound to a trip (made by hand here; check-in does it in the gate tests)
    await database.query("update rfid_cards set status = 'IN_USE' where id = $1", [card.id]);
    const bound = await call("PATCH", `/api/rfid-cards/${card.id}`, "logistics", { status: "AVAILABLE" });
    expect(bound.statusCode).toBe(409);
    expect(bound.json().error.code).toBe("INVALID_STATE");
    // label and note may still change
    expect((await call("PATCH", `/api/rfid-cards/${card.id}`, "logistics", { label: "K-10" })).statusCode).toBe(200);
  });

  it("is for logistics admins and system admins only", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/rfid-cards", "pos")).statusCode).toBe(403);
    expect((await call("POST", "/api/rfid-cards", "pks", { uid: "DD000001" })).statusCode).toBe(403);
  });
});
