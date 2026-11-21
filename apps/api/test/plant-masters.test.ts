// Plant masters (module plant_masters): storage tanks and the stock of seal numbers.
import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { seedProduct } from "./helpers/fixtures.js";
import { bearer, seedPartner, seedPartnerUser, seedStaff } from "./helpers/users.js";

type Method = "GET" | "POST" | "PATCH";

async function setup() {
  const ctx = await testApp();
  const { app, database } = ctx;
  await seedStaff(database, "pabrik", { plant_masters: "EDIT" });
  await seedStaff(database, "pembuat", { plant_masters: "CREATE" });
  await seedStaff(database, "lihat", { plant_masters: "VIEW" });
  await seedStaff(database, "lain", { qc: "EDIT" });
  await seedPartnerUser(database, "mitra", await seedPartner(database, "PT Mitra Contoh", { supplier: true }));
  const cpo = await seedProduct(database, "Minyak Contoh Mentah", "CPO");
  const olein = await seedProduct(database, "Minyak Contoh Olahan", "BULK_LIQUID");
  const headers = new Map<string, { authorization: string }>();
  const call = async (method: Method, url: string, as = "pabrik", payload?: object) => {
    if (!headers.has(as)) headers.set(as, await bearer(app, as));
    return app.inject({ method, url, headers: headers.get(as), ...(payload ? { payload } : {}) });
  };
  const audit = (action: string) => database.query<{ entity_id: number; after: unknown }>("select entity_id::int as entity_id, after from audit_log where action = $1 order by id", [action]);
  return { ...ctx, call, cpo, olein, audit };
}

describe("tanks", () => {
  it("creates, lists, filters and changes a tank, with an audit row each time", async () => {
    const { call, cpo, olein, audit } = await setup();
    const created = await call("POST", "/api/tanks", "pembuat", { code: " tk-101 ", name: "Tangki 101", productId: cpo, capacityKg: 2_000_000 });
    expect(created.statusCode, created.body).toBe(201);
    const tank = created.json().tank;
    expect(tank).toEqual({ id: expect.any(Number), code: "TK-101", name: "Tangki 101", product: { id: cpo, name: "Minyak Contoh Mentah" }, capacityKg: 2_000_000, isActive: true });
    await call("POST", "/api/tanks", "pabrik", { code: "TK-201", productId: olein });
    await call("POST", "/api/tanks", "pabrik", { code: "TK-301", isActive: false });

    const all = (await call("GET", "/api/tanks", "lihat")).json();
    expect(all.items.map((row: { code: string }) => row.code)).toEqual(["TK-101", "TK-201", "TK-301"]);
    expect((await call("GET", `/api/tanks?productId=${cpo}`, "lihat")).json().items.map((row: { code: string }) => row.code)).toEqual(["TK-101"]);
    expect((await call("GET", "/api/tanks?active=false", "lihat")).json().items.map((row: { code: string }) => row.code)).toEqual(["TK-301"]);
    expect((await call("GET", "/api/tanks?q=20", "lihat")).json().items.map((row: { code: string }) => row.code)).toEqual(["TK-201"]);

    const changed = await call("PATCH", `/api/tanks/${tank.id}`, "pabrik", { name: "Tangki CPO 101", productId: null, capacityKg: null, isActive: false });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().tank).toMatchObject({ code: "TK-101", name: "Tangki CPO 101", product: null, capacityKg: null, isActive: false });
    expect((await audit("TANK_CREATED")).length).toBe(3);
    expect(await audit("TANK_CHANGED")).toEqual([expect.objectContaining({ entity_id: tank.id })]);
  });

  it("refuses a code used at the site, a bad code, an unknown product, a negative capacity and an unknown tank", async () => {
    const { call, cpo } = await setup();
    const first = (await call("POST", "/api/tanks", "pabrik", { code: "TK-1", productId: cpo })).json().tank;
    await call("POST", "/api/tanks", "pabrik", { code: "TK-2" });
    const again = await call("POST", "/api/tanks", "pabrik", { code: "tk-1" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toEqual({ code: "DUPLICATE", message: "Kode tangki TK-1 sudah dipakai." });
    expect((await call("PATCH", `/api/tanks/${first.id}`, "pabrik", { code: "TK-2" })).statusCode).toBe(409);
    const bad = await call("POST", "/api/tanks", "pabrik", { code: "TK 1!", productId: 999_999, capacityKg: -5 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields.map((field: { field: string }) => field.field).sort()).toEqual(["capacityKg", "code"]);
    const unknownProduct = await call("POST", "/api/tanks", "pabrik", { code: "TK-9", productId: 999_999 });
    expect(unknownProduct.json().error.fields).toEqual([{ field: "productId", message: "Produk tidak ditemukan." }]);
    expect((await call("PATCH", "/api/tanks/999999", "pabrik", { name: "X" })).statusCode).toBe(404);
  });

  it("needs plant_masters: view to list, create to add, edit to change; staff only", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/tanks", "lain")).statusCode).toBe(403);
    expect((await call("GET", "/api/tanks", "mitra")).statusCode).toBe(403);
    expect((await call("POST", "/api/tanks", "lihat", { code: "TK-5" })).statusCode).toBe(403);
    const id = (await call("POST", "/api/tanks", "pembuat", { code: "TK-5" })).json().tank.id;
    expect((await call("PATCH", `/api/tanks/${id}`, "pembuat", { name: "X" })).statusCode).toBe(403);
  });
});

describe("seals", () => {
  it("adds a numbered batch, skips numbers that exist and counts them, and lists the stock", async () => {
    const { call, database, audit } = await setup();
    const made = await call("POST", "/api/seals/batch", "pembuat", { kind: "LOCIS", prefix: "lc-", from: 8, to: 12, width: 4 });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toEqual({ created: 5, skipped: 0, first: "LC-0008", last: "LC-0012" });
    const overlap = await call("POST", "/api/seals/batch", "pembuat", { kind: "LOCIS", prefix: "LC-", from: 11, to: 14, width: 4 });
    expect(overlap.json()).toEqual({ created: 2, skipped: 2, first: "LC-0011", last: "LC-0014" });
    // the same numbers of another kind are another series
    expect((await call("POST", "/api/seals/batch", "pembuat", { kind: "CUSTOMS", prefix: "LC-", from: 8, to: 8, width: 4 })).json()).toMatchObject({ created: 1, skipped: 0 });
    expect(await database.query("select count(*)::int as n from seals where batch_ref is not null")).toEqual([{ n: 8 }]);
    expect((await audit("SEALS_ADDED")).length).toBe(3);

    const listed = (await call("GET", "/api/seals?kind=LOCIS&limit=3", "lihat")).json();
    expect(listed.total).toBe(7);
    expect(listed.items.map((row: { sealNo: string }) => row.sealNo)).toEqual(["LC-0008", "LC-0009", "LC-0010"]);
    expect(listed.items[0]).toEqual({ id: expect.any(Number), sealNo: "LC-0008", kind: "LOCIS", status: "AVAILABLE", batchRef: "LC-0008..LC-0012", createdAt: expect.any(String), trip: null });
    const page = (await call("GET", "/api/seals?kind=LOCIS&limit=3&offset=6", "lihat")).json();
    expect(page.items.map((row: { sealNo: string }) => row.sealNo)).toEqual(["LC-0014"]);
    expect((await call("GET", "/api/seals?q=0013", "lihat")).json().items.map((row: { sealNo: string }) => row.sealNo)).toEqual(["LC-0013"]);
  });

  it("refuses a reversed range, more than 5 000 numbers, a width too small and a bad prefix", async () => {
    const { call } = await setup();
    const fields = async (body: object) => (await call("POST", "/api/seals/batch", "pabrik", body)).json().error.fields.map((field: { field: string; message: string }) => field.message);
    expect(await fields({ kind: "LOCIS", prefix: "A", from: 10, to: 9, width: 4 })).toEqual(["Nomor akhir tidak boleh lebih kecil dari nomor awal."]);
    expect(await fields({ kind: "LOCIS", prefix: "A", from: 1, to: 5_001, width: 6 })).toEqual(["Paling banyak 5.000 segel sekali tambah."]);
    expect(await fields({ kind: "LOCIS", prefix: "A", from: 1, to: 12_345, width: 4 })).toEqual(expect.arrayContaining(["Lebar angka kurang untuk nomor 12345."]));
    expect(await fields({ kind: "LOCIS", prefix: "A B", from: 1, to: 2, width: 4 })).toEqual(["Awalan hanya boleh huruf, angka, garis miring, dan tanda minus."]);
    expect((await call("POST", "/api/seals/batch", "pabrik", { kind: "OTHER", from: 1, to: 2, width: 4 })).statusCode).toBe(400);
    // exactly 5 000 is allowed
    expect((await call("POST", "/api/seals/batch", "pabrik", { kind: "LOCIS", prefix: "B", from: 1, to: 5_000, width: 4 })).json()).toMatchObject({ created: 5_000 });
  });

  it("voids an available seal only, with edit level", async () => {
    const { call, database } = await setup();
    await call("POST", "/api/seals/batch", "pabrik", { kind: "LOCIS", prefix: "V", from: 1, to: 3, width: 2 });
    const [a, b] = (await call("GET", "/api/seals", "lihat")).json().items as { id: number }[];
    expect((await call("PATCH", `/api/seals/${a?.id}`, "pembuat", { status: "VOID" })).statusCode).toBe(403);
    const voided = await call("PATCH", `/api/seals/${a?.id}`, "pabrik", { status: "VOID" });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().seal).toMatchObject({ id: a?.id, status: "VOID" });
    const twice = await call("PATCH", `/api/seals/${a?.id}`, "pabrik", { status: "VOID" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("INVALID_STATE");
    await database.query("update seals set status = 'USED' where id = $1", [b?.id]);
    expect((await call("PATCH", `/api/seals/${b?.id}`, "pabrik", { status: "VOID" })).statusCode).toBe(409);
    expect((await call("PATCH", `/api/seals/${b?.id}`, "pabrik", { status: "AVAILABLE" })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/seals/999999", "pabrik", { status: "VOID" })).statusCode).toBe(404);
    expect((await call("GET", "/api/seals?status=VOID", "lihat")).json().items).toEqual([expect.objectContaining({ id: a?.id })]);
  });

  it("needs plant_masters and a staff account", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/seals", "lain")).statusCode).toBe(403);
    expect((await call("GET", "/api/seals", "mitra")).statusCode).toBe(403);
    expect((await call("POST", "/api/seals/batch", "lihat", { kind: "LOCIS", prefix: "A", from: 1, to: 2, width: 2 })).statusCode).toBe(403);
  });
});
