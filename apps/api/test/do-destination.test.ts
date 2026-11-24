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
    expect(created.json().deliveryOrder.destination).toEqual({ id: null, name: "Gudang Pembeli", address: null, district: null, regency: "Kab. Contoh", province: null, location: null });

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
    expect(sent.json().deliveryOrder.destination).toEqual({ id: null, ...{ name: "Gudang Pembeli", address: "Jl. Contoh 9", district: "Kec. Contoh", regency: "Kab. Contoh", province: "Prov. Contoh" }, location: null });
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
    expect(created.json().deliveryOrder.destination).toEqual({ id: null, name: DESTINATION.destName, address: DESTINATION.destAddress, district: DESTINATION.destDistrict, regency: DESTINATION.destRegency, province: DESTINATION.destProvince, location: null });
  });
});

// open sea, far from any real place
const PIN = { lat: -10.5, lon: 85.25 };

describe("map pin of the destination", () => {
  it("is optional, set and cleared on a draft, and locked with the typed parts once the DO is sent", async () => {
    const { call, base } = await setup();
    const plain = await call("POST", "/api/delivery-orders", "logistics", { ...base, ...DESTINATION });
    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json().deliveryOrder.destination.location).toBeNull();

    const created = await call("POST", "/api/delivery-orders", "logistics", { ...base, ...DESTINATION, destLocation: PIN });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().deliveryOrder.id;
    expect(created.json().deliveryOrder.destination.location).toEqual(PIN);
    expect((await call("GET", `/api/delivery-orders/${id}`, "logistics")).json().deliveryOrder.destination.location).toEqual(PIN);

    // a change of another field keeps the pin
    expect((await call("PATCH", `/api/delivery-orders/${id}`, "logistics", { remark: "Catatan" })).json().deliveryOrder.destination.location).toEqual(PIN);
    const moved = await call("PATCH", `/api/delivery-orders/${id}`, "logistics", { destLocation: { lat: -10.75, lon: 85.5 } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().deliveryOrder.destination.location).toEqual({ lat: -10.75, lon: 85.5 });
    const cleared = await call("PATCH", `/api/delivery-orders/${id}`, "logistics", { destLocation: null });
    expect(cleared.json().deliveryOrder.destination.location).toBeNull();
    expect((await call("PATCH", `/api/delivery-orders/${id}`, "logistics", { destLocation: PIN })).statusCode).toBe(200);

    // a DO is sent without a pin as well as with one
    expect((await call("POST", `/api/delivery-orders/${plain.json().deliveryOrder.id}/send`, "logistics", {})).statusCode).toBe(200);
    expect((await call("POST", `/api/delivery-orders/${id}/send`, "logistics", {})).statusCode).toBe(200);
    const late = await call("PATCH", `/api/delivery-orders/${id}`, "logistics", { destLocation: null });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("INVALID_STATE");
    // the transporter sees the pin
    expect((await call("GET", `/api/delivery-orders/${id}`, "angkut1")).json().deliveryOrder.destination.location).toEqual(PIN);
  });

  it("refuses a pin outside the earth's ranges or with a part missing", async () => {
    const { call, base } = await setup();
    const send = (destLocation: unknown) => call("POST", "/api/delivery-orders", "logistics", { ...base, ...DESTINATION, destLocation });
    const fieldsOf = async (destLocation: unknown) => {
      const response = await send(destLocation);
      expect(response.statusCode).toBe(400);
      return response.json().error.fields;
    };
    expect(await fieldsOf({ lat: 91, lon: 10 })).toEqual([{ field: "destLocation.lat", message: "Lintang pin harus angka antara -90 dan 90." }]);
    expect(await fieldsOf({ lat: 10, lon: -180.5 })).toEqual([{ field: "destLocation.lon", message: "Bujur pin harus angka antara -180 dan 180." }]);
    expect(await fieldsOf({ lat: 10 })).toEqual([{ field: "destLocation.lon", message: "Bujur pin harus angka antara -180 dan 180." }]);
    expect(await fieldsOf({ lat: "3.5", lon: 10 })).toEqual([{ field: "destLocation.lat", message: "Lintang pin harus angka antara -90 dan 90." }]);
    expect(await fieldsOf("3.5, 98.6")).toEqual([{ field: "destLocation", message: "Pin lokasi tujuan harus berisi lintang dan bujur." }]);
    // the edges are allowed
    expect((await send({ lat: -90, lon: 180 })).statusCode).toBe(201);
  });

  it("the database keeps both parts set or both empty, inside the ranges (migration 0013)", async () => {
    const { call, base, database } = await setup();
    const id = (await call("POST", "/api/delivery-orders", "logistics", { ...base, ...DESTINATION })).json().deliveryOrder.id;
    const update = (lat: number | null, lon: number | null) => database.query("update delivery_orders set dest_lat = $1, dest_lon = $2 where id = $3", [lat, lon, id]);
    await expect(update(1, null)).rejects.toThrow(/delivery_orders_dest_pin_check/);
    await expect(update(null, 1)).rejects.toThrow(/delivery_orders_dest_pin_check/);
    await expect(update(90.5, 1)).rejects.toThrow(/delivery_orders_dest_pin_check/);
    await expect(update(1, 181)).rejects.toThrow(/delivery_orders_dest_pin_check/);
    await update(PIN.lat, PIN.lon);
    await update(null, null);
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
