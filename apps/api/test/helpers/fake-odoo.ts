// A stand-in for Odoo 13 on 127.0.0.1 that answers POST /jsonrpc the way the real server does for
// object.execute_kw … search_read: { result: [...] } or { error: { message, data: { message } } }.
// It applies the domain (=, !=, in, >, >=), hides archived records unless the domain mentions `active`,
// projects `fields`, orders by id and applies offset and limit.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

export type OdooRow = { id: number } & Record<string, unknown>;

export interface OdooCall {
  /** The JSON body as received. */
  body: Record<string, unknown>;
  service: unknown;
  rpcMethod: unknown;
  model: unknown;
  /** The model method: the only one this application may send is search_read. */
  method: unknown;
  domain: unknown[];
  options: { fields?: string[]; limit?: number; offset?: number; order?: string };
}

export const ODOO_ENV = { ODOO_DB: "live_test", ODOO_UID: "7", ODOO_PASSWORD: "odoo-secret" };

type Leaf = [string, string, unknown];

function matches(row: OdooRow, [field, operator, value]: Leaf): boolean {
  const raw = row[field];
  // a many2one is stored as [id, name]; a domain compares its id
  const actual = Array.isArray(raw) ? raw[0] : raw;
  switch (operator) {
    case "=":
      return actual === value;
    case "!=":
      return actual !== value;
    case "in":
      return (value as unknown[]).includes(actual);
    case ">":
      return String(actual) > String(value);
    case ">=":
      return String(actual) >= String(value);
    default:
      throw new Error(`fake Odoo: operator ${operator} is not supported`);
  }
}

export async function startFakeOdoo(records: Record<string, OdooRow[]> = {}) {
  const calls: OdooCall[] = [];
  let failure: { model?: string; message: string } | null = null;
  let gate: Promise<void> | null = null;

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method !== "POST" || request.url !== "/jsonrpc") return send(404, {});

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const params = (body.params ?? {}) as { service?: unknown; method?: unknown; args?: unknown[] };
    const [db, uid, password, model, method, positional, options] = (params.args ?? []) as [unknown, unknown, unknown, string, unknown, unknown[][], OdooCall["options"]];
    const domain = (positional?.[0] ?? []) as Leaf[];
    calls.push({ body, service: params.service, rpcMethod: params.method, model, method, domain, options: options ?? {} });
    if (gate) await gate;

    const fail = (message: string) => send(200, { jsonrpc: "2.0", id: body.id, error: { code: 200, message: "Odoo Server Error", data: { name: "odoo.exceptions.AccessDenied", message } } });
    if (db !== ODOO_ENV.ODOO_DB || uid !== Number(ODOO_ENV.ODOO_UID) || password !== ODOO_ENV.ODOO_PASSWORD) return fail("Access denied");
    if (failure && (failure.model === undefined || failure.model === model)) return fail(failure.message);
    if (params.service !== "object" || params.method !== "execute_kw" || method !== "search_read") return fail(`fake Odoo: ${String(method)} is not allowed`);

    let rows = records[model] ?? [];
    const hasActive = rows.some((row) => "active" in row);
    if (hasActive && !domain.some((leaf) => leaf[0] === "active")) rows = rows.filter((row) => row.active !== false);
    rows = rows.filter((row) => domain.every((leaf) => matches(row, leaf))).sort((a, b) => a.id - b.id);
    const offset = options?.offset ?? 0;
    rows = rows.slice(offset, options?.limit ? offset + options.limit : undefined);
    const fields = options?.fields;
    const result = rows.map((row) => (fields ? Object.fromEntries([["id", row.id], ...fields.map((field) => [field, row[field] ?? false])]) : row));
    return send(200, { jsonrpc: "2.0", id: body.id, result });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // fetch keeps its connection open; without closing it the server would wait for it to time out
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  onTestFinished(async () => {
    if (server.listening) await close();
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    /** Environment keys that point the application at this server. */
    get env() {
      return { ...ODOO_ENV, ODOO_URL: this.url };
    },
    records,
    calls,
    /** Makes every request (or every request for one model) answer an Odoo error. */
    failWith(message: string, model?: string) {
      failure = { message, model };
    },
    recover() {
      failure = null;
    },
    /** Makes the server wait before it answers; call the returned function to let the answers go. */
    hold(): () => void {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    close,
  };
}

/**
 * A small Odoo: six purchase contracts (one per state the sync knows), four sales contracts, their lines,
 * four products (one of them a service) and three partners. Tests change the returned object in place.
 */
export function sampleOdooRecords(): Record<string, OdooRow[]> {
  const purchase = (id: number, state: string, extra: Record<string, unknown> = {}): OdooRow => ({
    id,
    name: `020${id}/K/CPO/XI/2026`,
    vendor_id: [11, "PT PKS A"],
    state,
    tolerance: 0.3,
    jenis_material: "MB",
    ordering_date: "2026-11-01",
    date_end: "2026-11-30 17:00:00",
    write_date: `2026-11-10 02:00:0${id}`,
    ...extra,
  });
  const sale = (id: number, state: string, extra: Record<string, unknown> = {}): OdooRow => ({
    id,
    name: `10${id}A/SC/FR/INL/X/2026`,
    partner_id: [12, "PT Customer C"],
    state,
    po_customer: "PO-77",
    contract_date: "2026-10-15",
    validity_date: "2026-12-31",
    certificate: "ISCC",
    write_date: `2026-11-11 03:00:0${id}`,
    ...extra,
  });
  return {
    "purchase.requisition": [
      purchase(1, "ongoing"),
      purchase(2, "in_progress", { tolerance: false, jenis_material: false, date_end: false, ordering_date: false }),
      purchase(3, "open"),
      purchase(4, "done"),
      purchase(5, "cancel"),
      purchase(6, "draft", { vendor_id: [13, "PT Draft Only"] }),
    ],
    "purchase.requisition.line": [1, 2, 3, 4, 5, 6].map((id) => ({
      id: 100 + id,
      requisition_id: [id, `020${id}/K/CPO/XI/2026`],
      product_id: [21, "Crude Palm Oil"],
      product_uom_id: [3, "kg"],
      product_qty: 1000000.1234,
    })),
    "sale.blanket.order": [sale(1, "open"), sale(2, "done", { po_customer: false, certificate: false }), sale(3, "expired"), sale(4, "draft")],
    "sale.blanket.order.line": [
      { id: 201, order_id: [1, "101A/SC/FR/INL/X/2026"], product_id: [22, "[OLN] RBD Palm Olein"], product_uom: [3, "kg"], original_uom_qty: 2000000, delivered_uom_qty: 150000.5 },
      { id: 202, order_id: [1, "101A/SC/FR/INL/X/2026"], product_id: [23, "Freight"], product_uom: [1, "Unit"], original_uom_qty: 1, delivered_uom_qty: 0 },
      { id: 203, order_id: [2, "102A/SC/FR/INL/X/2026"], product_id: [24, "Minyak Goreng 1L"], product_uom: [9, "Karton"], original_uom_qty: 500, delivered_uom_qty: 0 },
      { id: 204, order_id: [3, "103A/SC/FR/INL/X/2026"], product_id: [22, "[OLN] RBD Palm Olein"], product_uom: [3, "kg"], original_uom_qty: 10000, delivered_uom_qty: 10000 },
      { id: 205, order_id: [4, "104A/SC/FR/INL/X/2026"], product_id: [22, "[OLN] RBD Palm Olein"], product_uom: [3, "kg"], original_uom_qty: 10000, delivered_uom_qty: 0 },
    ],
    "product.product": [
      { id: 21, name: "Crude Palm Oil", default_code: "CPO", uom_id: [3, "kg"], type: "product", location_type: false, active: true },
      { id: 22, name: "RBD Palm Olein", default_code: "OLN", uom_id: [3, "kg"], type: "product", location_type: false, active: true },
      { id: 23, name: "Freight", default_code: false, uom_id: [1, "Unit"], type: "service", location_type: false, active: true },
      { id: 24, name: "Minyak Goreng 1L", default_code: "MG1", uom_id: [9, "Karton"], type: "product", location_type: "finish_product", active: false },
    ],
    "res.partner": [
      { id: 11, name: "PT PKS A", ref: "V011", street: "Jl. Kebun 1", street2: false, city: "Simalungun", active: true },
      { id: 12, name: "PT Customer C", ref: false, street: false, street2: false, city: false, active: true },
      { id: 13, name: "PT Draft Only", ref: false, street: false, street2: false, city: false, active: true },
    ],
  };
}
