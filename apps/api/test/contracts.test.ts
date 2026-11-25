import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { testApp } from "./helpers/app.js";
import { bearer, LOGISTICS, seedPartner, seedPartnerUser, seedStaff, SUPPLIER, VIEWER } from "./helpers/users.js";

interface ContractSeed {
  line: number;
  no: string;
  partnerId: number;
  productId: number;
  direction?: "IN" | "OUT";
  state?: "OPEN" | "CLOSED" | "CANCELLED";
  validUntil?: string | null;
  validFrom?: string | null;
}

async function seedContract(database: Database, seed: ContractSeed): Promise<number> {
  const direction = seed.direction ?? "IN";
  const [row] = await database.query<{ id: number }>(
    `insert into erp_contracts (erp_system, erp_ref, direction, contract_no, partner_id, product_id, qty_contract, uom, tolerance_pct, certificate,
                                valid_from, valid_until, contract_date, customer_po_no, state, synced_at)
     values ('ODOO', $1, $2, $3, $4, $5, 2000000.5, 'kg', 0.3, 'ISCC', $8, $6, '2026-10-15', 'PO-77', $7, '2026-11-20T01:00:00Z')
     returning id::int as id`,
    [
      `${direction === "IN" ? "purchase.requisition" : "sale.blanket.order"}.line,${seed.line}`, direction, seed.no, seed.partnerId, seed.productId,
      seed.validUntil ?? null, seed.state ?? "OPEN", seed.validFrom === undefined ? "2026-10-15" : seed.validFrom,
    ],
  );
  return Number(row?.id);
}

/** Clock of the tests: 2026-11-20 10:00 in Jakarta. */
async function setup() {
  const context = await testApp();
  const { database } = context;
  const pksA = await seedPartner(database, "PT PKS Alpha", { erpRef: "11" });
  const pksB = await seedPartner(database, "PT Sawit Beta", { erpRef: "12" });
  const [cpo] = await database.query<{ id: number }>("insert into products (erp_system, erp_ref, name, category) values ('ODOO', '21', 'Crude Palm Oil', 'CPO') returning id::int as id");
  const [olein] = await database.query<{ id: number }>("insert into products (erp_system, erp_ref, name, category) values ('ODOO', '22', 'RBD Palm Olein', 'BULK_LIQUID') returning id::int as id");
  const cpoId = Number(cpo?.id);
  const oleinId = Number(olein?.id);

  const ids = {
    open: await seedContract(database, { line: 1, no: "0200/K/CPO/XI/2026", partnerId: pksA, productId: cpoId }),
    endsToday: await seedContract(database, { line: 2, no: "0201/K/CPO/XI/2026", partnerId: pksB, productId: cpoId, validUntil: "2026-11-20" }),
    expired: await seedContract(database, { line: 3, no: "0202/K/CPO/XI/2026", partnerId: pksA, productId: cpoId, validUntil: "2026-11-19" }),
    closed: await seedContract(database, { line: 4, no: "0203/K/CPO/XI/2026", partnerId: pksA, productId: cpoId, state: "CLOSED" }),
    cancelled: await seedContract(database, { line: 5, no: "0204/K/CPO/XI/2026", partnerId: pksB, productId: cpoId, state: "CANCELLED" }),
    sale: await seedContract(database, { line: 9, no: "101A/SC/FR/XYZ/X/2026", partnerId: pksA, productId: oleinId, direction: "OUT", validUntil: "2026-12-31" }),
  };
  await seedStaff(database, "logistics", LOGISTICS);
  const headers = await bearer(context.app, "logistics");
  const search = async (query = "", as = headers) => {
    const response = await context.app.inject({ method: "GET", url: `/api/contracts${query}`, headers: as });
    const body = response.json() as { items: { id: number; contractNo: string }[]; total: number };
    return { response, body, numbers: body.items?.map((item) => item.contractNo), found: body.items?.map((item) => item.id) };
  };
  return { ...context, pksA, pksB, cpoId, oleinId, ids, search, headers };
}

describe("GET /api/contracts", () => {
  it("lists open contracts that have not ended, with partner and product, quantities as numbers", async () => {
    const { search, ids, pksA, oleinId } = await setup();
    const { response, body } = await search();
    expect(response.statusCode).toBe(200);
    expect(body.total).toBe(3);
    expect(body.items.map((item) => item.id)).toEqual([ids.open, ids.endsToday, ids.sale]);
    expect(body.items[2]).toEqual({
      id: ids.sale,
      contractNo: "101A/SC/FR/XYZ/X/2026",
      direction: "OUT",
      partner: { id: pksA, name: "PT PKS Alpha" },
      product: { id: oleinId, name: "RBD Palm Olein", category: "BULK_LIQUID" },
      qtyContract: 2000000.5,
      uom: "kg",
      tolerancePct: 0.3,
      certificate: "ISCC",
      validFrom: "2026-10-15",
      validUntil: "2026-12-31",
      customerPoNo: "PO-77",
      state: "OPEN",
      syncedAt: "2026-11-20T01:00:00.000Z",
      shipmentRequest: null,
      requests: { open: 0, sent: 0, qtyRequested: 0 },
    });
    expect(body.items[0]).toMatchObject({ validUntil: null });
  });

  it("lists the most recent contract first, undated ones last", async () => {
    const { search, database, pksA, cpoId } = await setup();
    await seedContract(database, { line: 20, no: "0999/K/CPO/I/2026", partnerId: pksA, productId: cpoId, validFrom: "2026-01-05" });
    await seedContract(database, { line: 21, no: "0100/K/CPO/XI/2026", partnerId: pksA, productId: cpoId, validFrom: "2026-11-18" });
    await seedContract(database, { line: 22, no: "0001/K/CPO/XI/2026", partnerId: pksA, productId: cpoId, validFrom: null });
    const { numbers } = await search("?direction=IN");
    expect(numbers).toEqual(["0100/K/CPO/XI/2026", "0200/K/CPO/XI/2026", "0201/K/CPO/XI/2026", "0999/K/CPO/I/2026", "0001/K/CPO/XI/2026"]);
  });

  it("filters by direction", async () => {
    const { search, ids } = await setup();
    expect((await search("?direction=IN")).found).toEqual([ids.open, ids.endsToday]);
    const out = await search("?direction=OUT");
    expect(out.found).toEqual([ids.sale]);
    expect(out.body.total).toBe(1);
  });

  it("matches q against contract number and partner name, without regard to case, as plain text", async () => {
    const { search, ids, database, pksA, cpoId } = await setup();
    expect((await search("?q=k/cpo")).found).toEqual([ids.open, ids.endsToday]);
    expect((await search("?q=101a")).found).toEqual([ids.sale]);
    expect((await search("?q=sawit%20BETA")).found).toEqual([ids.endsToday]);
    expect((await search("?q=alpha&direction=IN")).found).toEqual([ids.open]);
    expect((await search("?q=tidak-ada")).body).toEqual({ items: [], total: 0 });

    // % and _ are searched for, not treated as wildcards
    const odd = await seedContract(database, { line: 30, no: "50%_X/K/2026", partnerId: pksA, productId: cpoId });
    expect((await search(`?q=${encodeURIComponent("%_x")}`)).found).toEqual([odd]);
    expect((await search(`?q=${encodeURIComponent("0_0")}`)).found).toEqual([]);
  });

  it("hides closed, cancelled and ended contracts unless includeClosed=true", async () => {
    const { search, ids } = await setup();
    const all = await search("?includeClosed=true");
    expect(all.found).toEqual([ids.open, ids.endsToday, ids.expired, ids.closed, ids.cancelled, ids.sale]);
    expect(all.body.total).toBe(6);
    expect((await search("?includeClosed=false")).body.total).toBe(3);
  });

  it("takes today from the plant's time zone", async () => {
    // 19 November 17:30 UTC is 20 November 00:30 in Jakarta: a contract valid until the 19th has ended
    const { search, ids, clock } = await setup();
    clock.advance(-(9 * 3600 + 30 * 60) * 1000);
    expect((await search("?direction=IN&includeClosed=true")).found).toContain(ids.expired);
    expect((await search("?direction=IN")).found).toEqual([ids.open, ids.endsToday]);
    // 16:30 UTC on the 19th is still the 19th in Jakarta
    clock.advance(-3600 * 1000);
    expect((await search("?direction=IN")).found).toEqual([ids.open, ids.endsToday, ids.expired]);
  });

  it("answers 20 rows by default and never more than 50", async () => {
    const { search, database, pksA, cpoId } = await setup();
    for (let line = 100; line < 160; line++) await seedContract(database, { line, no: `9${line}/K/CPO/XI/2026`, partnerId: pksA, productId: cpoId });

    const standard = await search("?q=9");
    expect(standard.body.items).toHaveLength(20);
    const capped = await search("?q=/K/CPO&limit=500&direction=IN");
    expect(capped.body.items).toHaveLength(50);
    expect(capped.body.total).toBe(62);
    expect((await search("?limit=3")).body.items).toHaveLength(3);
  });

  it("answers 400 VALIDATION for a wrong direction, limit or includeClosed", async () => {
    const { search } = await setup();
    const wrong = await search("?direction=UP&limit=0&includeClosed=yes");
    expect(wrong.response.statusCode).toBe(400);
    expect(wrong.response.json().error).toEqual({
      code: "VALIDATION",
      message: "Data yang dikirim tidak valid.",
      fields: [
        { field: "direction", message: "Arah harus IN atau OUT." },
        { field: "limit", message: "Limit harus angka mulai dari 1." },
        { field: "includeClosed", message: "includeClosed harus true atau false." },
      ],
    });
  });

  it("shows a partner account only the contracts of its own company, whatever it asks for", async () => {
    const { search, app, database, pksA, pksB, ids } = await setup();
    await seedPartnerUser(database, "beta", pksB, SUPPLIER);
    const beta = await bearer(app, "beta");

    expect((await search("", beta)).body).toMatchObject({ total: 1 });
    expect((await search("", beta)).found).toEqual([ids.endsToday]);
    expect((await search("?includeClosed=true", beta)).found).toEqual([ids.endsToday, ids.cancelled]);
    expect((await search(`?q=alpha&partnerId=${pksA}&partner_id=${pksA}&includeClosed=true`, beta)).body).toEqual({ items: [], total: 0 });
    expect((await search("?direction=OUT&includeClosed=true", beta)).found).toEqual([]);
    expect((await search("?q=0200", beta)).found).toEqual([]);
  });

  it("needs a signed-in account with contracts:VIEW, and a staff account without any permission gets NO_ACCESS", async () => {
    const { search, app, database } = await setup();
    expect((await search("", {} as never)).response.statusCode).toBe(401);

    const id = await seedStaff(database, "newcomer", VIEWER);
    const qc = await bearer(app, "newcomer");
    expect((await search("", qc)).body.total).toBe(3);
    await database.query("delete from user_permissions where user_id = $1", [id]);
    const refused = await search("", qc);
    expect(refused.response.statusCode).toBe(403);
    expect(refused.response.json().error.code).toBe("NO_ACCESS");
  });
});
