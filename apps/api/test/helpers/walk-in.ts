// The registration post with a document scanner: the phase 3 application wired to the stand-in reading service,
// with the master data the default canned documents of fake-ocr.ts point to. Everything here is made up.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { startFakeOcr } from "./fake-ocr.js";
import { multipart } from "./field.js";
import { DESTINATION, phase3App, seedCard, seedContract, seedDriver, seedVehicle } from "./fixtures.js";
import { bearer } from "./users.js";

/** A tiny JPEG: the signature is what the API types a file by. */
export const JPEG_BYTES = Buffer.concat([Buffer.from("ffd8ffe000104a464946000101", "hex"), Buffer.alloc(64, 7), Buffer.from("ffd9", "hex")]);

/** Every file below a folder, as paths relative to it. */
export async function storedFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  };
  await walk(root, "");
  return found;
}

export async function walkInApp(env: Record<string, string> = {}, options: { ocrUrl?: string | null } = {}) {
  const ocr = await startFakeOcr();
  const ocrUrl = options.ocrUrl === undefined ? ocr.url : options.ocrUrl;
  const context = await phase3App({ ...(ocrUrl ? { OCR_API_URL: ocrUrl } : {}), ...env });
  const { app, database, companies, products, call } = context;
  const contracts = {
    // the contract of the default letter; without a quantity, so nothing counts against it
    main: await seedContract(database, { no: "0012/UJI/CPO-L/XI/2026", partnerId: companies.supplier1, productId: products.cpo, qty: null }),
    next: await seedContract(database, { no: "0013/UJI/CPO-L/XI/2026", partnerId: companies.supplier1, productId: products.cpo, qty: null }),
    closed: await seedContract(database, { no: "0855/UJI/CPO-L/V/2025", partnerId: companies.supplier1, productId: products.cpo, state: "CLOSED" }),
    sale: await seedContract(database, { no: "SC-401/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, qty: 1_000_000 }),
  };
  const vehicles = {
    letter: await seedVehicle(database, { plate: "BK 5001 EE", ownerId: companies.transporter1, capacityKg: 32_000 }),
    other: await seedVehicle(database, { plate: "BK 5002 EE", ownerId: companies.transporter1, capacityKg: 32_000 }),
  };
  const drivers = {
    letter: await seedDriver(database, { name: "Supir Surat Satu", licence: "SIMSURAT0001" }),
    other: await seedDriver(database, { name: "Supir Surat Dua", licence: "SIMSURAT0002" }),
    warning: await seedDriver(database, { name: "Supir Surat Tiga", licence: "SIMSURAT0003", status: "WARNING" }),
    blacklist: await seedDriver(database, { name: "Supir Surat Empat", licence: "SIMSURAT0004", status: "BLACKLIST" }),
  };
  const cards = {
    one: await seedCard(database, "AB0000000001", "K-01"),
    two: await seedCard(database, "AB0000000002", "K-02"),
  };

  /** POST /api/gate/scan-document with one file and the direction. */
  const scan = async (direction: string | null, options: { as?: string | null; bytes?: Buffer; name?: string; type?: string } = {}) => {
    const file = { name: options.name ?? "surat.jpg", type: options.type ?? "image/jpeg", bytes: options.bytes ?? JPEG_BYTES };
    const body = multipart(file, direction === null ? {} : { direction });
    const headers = options.as === null ? {} : await bearer(app, options.as ?? "pos");
    return app.inject({ method: "POST", url: "/api/gate/scan-document", headers: { ...headers, ...body.headers }, payload: body.payload });
  };
  const scanOk = async (direction: "IN" | "OUT", as = "pos") => {
    const response = await scan(direction, { as });
    if (response.statusCode !== 200) throw new Error(response.body);
    return response.json();
  };
  const walkIn = async (body: object, as: string | null = "pos") => call("POST", "/api/gate/walk-in", as, body);

  /** A DO sent to the first transporter and, unless told otherwise, accepted by it; answers its id and number. */
  const deliveryOrder = async (qty: number, accept = true) => {
    const created = await call("POST", "/api/delivery-orders", "logistics", {
      doDate: "2026-11-20", contractId: contracts.sale, qty, ...DESTINATION, deliveryFrom: "2026-11-20", deliveryUntil: "2026-11-30", transporterId: companies.transporter1,
    });
    if (created.statusCode !== 201) throw new Error(created.body);
    const order = created.json().deliveryOrder as { id: number; doNo: string };
    await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", {});
    if (accept) await call("POST", `/api/delivery-orders/${order.id}/accept`, "angkut1", {});
    return order;
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await database.query<{ n: number }>(sql, params))[0]?.n);

  return { ...context, ocr, contracts, vehicles, drivers, cards, scan, scanOk, walkIn, deliveryOrder, count };
}
