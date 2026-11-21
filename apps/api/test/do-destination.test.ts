// The destination of a delivery order is typed on the DO (owner's decision, 22 November 2026): name and regency
// are enough for a draft, all five parts are needed before it is sent. The "Tujuan" master is no longer used.
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { emptyDatabase } from "./helpers/app.js";
import { DESTINATION, phase3App, seedContract } from "./helpers/fixtures.js";

async function setup() {
  const ctx = await phase3App();
  const sale = await seedContract(ctx.database, { no: "SC-801/CONTOH", direction: "OUT", partnerId: ctx.companies.customer1, productId: ctx.products.olein, qty: 300_000 });
  const base = { doDate: "2026-11-20", contractId: sale, qty: 60_000, deliveryFrom: "2026-11-20", transporterId: ctx.companies.transporter1 };
  return { ...ctx, base };
}

describe("typed destination of a delivery order", () => {
  it("keeps a draft with the name and the regency, and shows what was typed", async () => {
    const { call, base } = await setup();
    const created = await call("POST", "/api/delivery-orders", "logistics", { ...base, destName: " Gudang Pembeli ", destRegency: "Kab. Contoh" });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().deliveryOrder.destination).toEqual({ id: null, name: "Gudang Pembeli", address: null, district: null, regency: "Kab. Contoh", province: null });

    const missing = await call("POST", "/api/delivery-orders", "logistics", { ...base, destAddress: "Jl. Contoh 9" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.fields).toEqual(
      expect.arrayContaining([
        { field: "destName", message: "Nama tujuan wajib diisi." },
        { field: "destRegency", message: "Kabupaten atau kota tujuan wajib diisi." },
      ]),
    );
  });

  it("needs all five parts before the DO is sent, and locks them afterwards", async () => {
    const { call, base } = await setup();
    const id = (await call("POST", "/api/delivery-orders", "logistics", { ...base, destName: "Gudang Pembeli", destRegency: "Kab. Contoh" })).json().deliveryOrder.id;
    const early = await call("POST", `/api/delivery-orders/${id}/send`, "logistics", {});
    expect(early.statusCode).toBe(400);
    expect(early.json().error.fields).toEqual([
      { field: "destAddress", message: "Alamat tujuan wajib diisi sebelum DO dikirim." },
      { field: "destDistrict", message: "Kecamatan tujuan wajib diisi sebelum DO dikirim." },
      { field: "destProvince", message: "Provinsi tujuan wajib diisi sebelum DO dikirim." },
    ]);
    const filled = await call("PATCH", `/api/delivery-orders/${id}`, "logistics", { destAddress: "Jl. Contoh 9", destDistrict: "Kec. Contoh", destProvince: "Prov. Contoh" });
    expect(filled.statusCode, filled.body).toBe(200);
    // an empty text clears a part again
    expect((await call("PATCH", `/api/delivery-orders/${id}`, "logistics", { destName: "  " })).statusCode).toBe(400);
    const sent = await call("POST", `/api/delivery-orders/${id}/send`, "logistics", {});
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().deliveryOrder.destination).toEqual({ id: null, ...{ name: "Gudang Pembeli", address: "Jl. Contoh 9", district: "Kec. Contoh", regency: "Kab. Contoh", province: "Prov. Contoh" } });
    const late = await call("PATCH", `/api/delivery-orders/${id}`, "logistics", { destAddress: "Jl. Lain" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("INVALID_STATE");

    // the transporter sees the same destination
    const seen = await call("GET", `/api/delivery-orders/${id}`, "angkut1");
    expect(seen.json().deliveryOrder.destination).toMatchObject({ name: "Gudang Pembeli", district: "Kec. Contoh", province: "Prov. Contoh" });
  });

  it("no longer reads the destination master: a destinationId is ignored", async () => {
    const { call, base } = await setup();
    const created = await call("POST", "/api/delivery-orders", "logistics", { ...base, ...DESTINATION, destinationId: 999_999 });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().deliveryOrder.destination).toEqual({ id: null, name: DESTINATION.destName, address: DESTINATION.destAddress, district: DESTINATION.destDistrict, regency: DESTINATION.destRegency, province: DESTINATION.destProvince });
  });
});

describe("migration 0008 and the destination of existing DOs", () => {
  it("copies the destination of every DO made before it and lets destination_id be empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "timbangan-0008-"));
    try {
      const before = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql") && name < "0008").sort();
      for (const name of before) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
      const database = await emptyDatabase();
      try {
        await migrate(database, { dir });
        const one = async (text: string, params: unknown[] = []) => Number((await database.query<{ id: number }>(text, params))[0]?.id);
        const customer = await one("insert into partners (name, is_customer) values ('PT Pembeli Contoh', true) returning id");
        const product = await one("insert into products (name, category, uom) values ('Minyak Contoh', 'BULK_LIQUID', 'kg') returning id");
        const user = await one("insert into users (kind, username, full_name, password_hash) values ('INTERNAL', 'pembuat', 'Pembuat Contoh', 'bukan-hash') returning id");
        const place = await one(
          "insert into destinations (partner_id, name, address, district, regency, province) values ($1, 'Gudang Lama', 'Jl. Lama 1', 'Kec. Lama', 'Kab. Lama', 'Prov. Lama') returning id",
          [customer],
        );
        await database.query(
          `insert into delivery_orders (site_id, do_no, do_date, partner_id, product_id, qty, destination_id, delivery_from, created_by)
           select id, 'DO-LAMA', '2026-11-20', $1, $2, 1000, $3, '2026-11-21', $4 from sites order by id limit 1`,
          [customer, product, place, user],
        );
        await copyFile(join(MIGRATIONS_DIR, "0008_tanks_attachments.sql"), join(dir, "0008_tanks_attachments.sql"));
        expect((await migrate(database, { dir })).applied).toEqual(["0008_tanks_attachments.sql"]);
        expect(await database.query("select dest_name, dest_address, dest_district, dest_regency, dest_province from delivery_orders")).toEqual([
          { dest_name: "Gudang Lama", dest_address: "Jl. Lama 1", dest_district: "Kec. Lama", dest_regency: "Kab. Lama", dest_province: "Prov. Lama" },
        ]);
        await database.query(
          `insert into delivery_orders (site_id, do_no, do_date, partner_id, product_id, qty, dest_name, dest_regency, delivery_from, created_by)
           select id, 'DO-BARU', '2026-11-20', $1, $2, 1000, 'Gudang Baru', 'Kab. Baru', '2026-11-21', $3 from sites order by id limit 1`,
          [customer, product, user],
        );
        expect(await database.query("select destination_id from delivery_orders where do_no = 'DO-BARU'")).toEqual([{ destination_id: null }]);
      } finally {
        await database.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
