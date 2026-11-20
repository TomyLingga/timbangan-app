// Copies contracts from Odoo 13 into erp_contracts (one row per contract line), with the partners and
// products they refer to. Read-only on the Odoo side. A run is incremental (headers changed after the last
// successful cursor) and idempotent: a row is written only when a copied value differs.
import { and, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Database, Orm } from "../db/client.js";
import { erpContracts, erpSyncRuns, partners, products } from "../db/schema.js";
import type { OdooClient, OdooDomain, OdooRecord } from "./client.js";
import { datePart, many2one, numberOrNull, textOrNull } from "./values.js";

export interface SyncResult {
  /** Rows inserted or changed in this run. */
  contracts: number;
  partners: number;
  products: number;
  /** Contract lines read from Odoo and not copied: drafts, service lines, lines without product or partner. */
  skipped: number;
  durationMs: number;
}

type ContractState = "OPEN" | "CLOSED" | "CANCELLED";
type Category = "CPO" | "BULK_LIQUID" | "PACKED" | "OTHER";

/** States that are not listed (draft, and anything unknown) are not copied. */
const PURCHASE_STATES: Record<string, ContractState> = { ongoing: "OPEN", in_progress: "OPEN", open: "OPEN", done: "CLOSED", cancel: "CANCELLED" };
const SALE_STATES: Record<string, ContractState> = { open: "OPEN", done: "OPEN", expired: "CLOSED" };

/** Used once, when a product is first copied; afterwards the category belongs to the admins. */
export function categoryOf(name: string, locationType: string | null, unitName: string | null): Category {
  const unit = (unitName ?? "").trim().toLowerCase();
  // "CPO" must start the name: Odoo also holds consumables named after a contract number that only contains it
  if (/crude palm oil/i.test(name) || /^\s*cpo\b/i.test(name)) return "CPO";
  if (locationType === "finish_product" || /^(box|pcs|pouch|unit|karton|dus)/.test(unit)) return "PACKED";
  if (unit === "kg" || unit === "liter" || unit === "ton" || unit === "mt") return "BULK_LIQUID";
  return "OTHER";
}

interface ContractDraft {
  erpRef: string;
  direction: "IN" | "OUT";
  contractNo: string;
  partnerRef: number;
  productRef: number;
  qtyContract: number | null;
  qtyDoneErp: number | null;
  customerPoNo: string | null;
  contractDate: string | null;
  uom: string | null;
  tolerancePct: number;
  certificate: string | null;
  validUntil: string | null;
  state: ContractState;
  raw: { header: OdooRecord; line: OdooRecord };
}

/** A selection comes as text, a many2one as [id, name]: either way the label. */
const label = (value: unknown) => many2one(value)?.name ?? textOrNull(value);

function purchaseDraft(header: OdooRecord, line: OdooRecord): ContractDraft | null {
  const state = PURCHASE_STATES[String(header.state)];
  const partner = many2one(header.vendor_id);
  const product = many2one(line.product_id);
  if (!state || !partner || !product) return null;
  return {
    erpRef: `purchase.requisition.line,${line.id}`,
    direction: "IN",
    contractNo: textOrNull(header.name) ?? String(header.id),
    partnerRef: partner.id,
    productRef: product.id,
    qtyContract: numberOrNull(line.product_qty),
    qtyDoneErp: null,
    customerPoNo: null,
    contractDate: datePart(header.ordering_date),
    uom: many2one(line.product_uom_id)?.name ?? null,
    tolerancePct: numberOrNull(header.tolerance) ?? 0,
    certificate: label(header.jenis_material),
    // date_end ("agreement deadline") equals the ordering date in practice, so a purchase contract has no end date
    validUntil: null,
    state,
    raw: { header, line },
  };
}

function saleDraft(header: OdooRecord, line: OdooRecord): ContractDraft | null {
  const state = SALE_STATES[String(header.state)];
  const partner = many2one(header.partner_id);
  const product = many2one(line.product_id);
  if (!state || !partner || !product) return null;
  return {
    erpRef: `sale.blanket.order.line,${line.id}`,
    direction: "OUT",
    contractNo: textOrNull(header.name) ?? String(header.id),
    partnerRef: partner.id,
    productRef: product.id,
    qtyContract: numberOrNull(line.original_uom_qty),
    qtyDoneErp: numberOrNull(line.delivered_uom_qty),
    customerPoNo: textOrNull(header.po_customer),
    contractDate: datePart(header.contract_date),
    uom: many2one(line.product_uom)?.name ?? null,
    tolerancePct: 0,
    certificate: label(header.certificate),
    validUntil: datePart(header.validity_date),
    state,
    raw: { header, line },
  };
}

const ids = (rows: OdooRecord[]) => rows.map((row) => row.id);
const uniqueSorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const byId = (rows: OdooRecord[]) => new Map(rows.map((row) => [row.id, row]));
/** Archived records are hidden by Odoo unless the domain mentions `active`. */
const withArchived = (wanted: number[]): OdooDomain => [["id", "in", wanted], ["active", "in", [true, false]]];

function* chunks<T>(rows: T[], size = 500): Generator<T[]> {
  for (let start = 0; start < rows.length; start += size) yield rows.slice(start, start + size);
}

const incoming = (column: PgColumn) => sql.raw(`excluded."${column.name}"`);
/** True when one of the columns of the stored row differs from the row Odoo sent. */
function differs(table: string, columns: PgColumn[]): SQL {
  const stored = columns.map((column) => `"${table}"."${column.name}"`).join(", ");
  const sent = columns.map((column) => `excluded."${column.name}"`).join(", ");
  return sql.raw(`(${stored}) is distinct from (${sent})`);
}
const takeIncoming = <T extends Record<string, PgColumn>>(columns: T) =>
  Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, incoming(column)])) as { [K in keyof T]: SQL };

async function readFromOdoo(client: OdooClient, cursor: string | null) {
  const changed: OdooDomain = cursor ? [["write_date", ">", cursor]] : [];
  const linesOf = (model: string, parent: string, headers: OdooRecord[], fields: string[]) =>
    headers.length === 0 ? [] : client.searchRead(model, [[parent, "in", ids(headers)]], [parent, ...fields]);

  const purchaseHeaders = await client.searchRead("purchase.requisition", changed, [
    "name", "vendor_id", "state", "tolerance", "jenis_material", "ordering_date", "date_end", "write_date",
  ]);
  const purchaseLines = await linesOf("purchase.requisition.line", "requisition_id", purchaseHeaders, ["product_id", "product_uom_id", "product_qty"]);
  const saleHeaders = await client.searchRead("sale.blanket.order", changed, [
    "name", "partner_id", "state", "po_customer", "contract_date", "validity_date", "certificate", "write_date",
  ]);
  const saleLines = await linesOf("sale.blanket.order.line", "order_id", saleHeaders, ["product_id", "product_uom", "original_uom_qty", "delivered_uom_qty"]);

  const purchases = byId(purchaseHeaders);
  const sales = byId(saleHeaders);
  const drafts: ContractDraft[] = [];
  for (const line of purchaseLines) {
    const header = purchases.get(many2one(line.requisition_id)?.id ?? -1);
    const draft = header && purchaseDraft(header, line);
    if (draft) drafts.push(draft);
  }
  for (const line of saleLines) {
    const header = sales.get(many2one(line.order_id)?.id ?? -1);
    const draft = header && saleDraft(header, line);
    if (draft) drafts.push(draft);
  }

  // Products first: a line whose product is a service (freight, insurance) is not a contract line here.
  const productIds = uniqueSorted(drafts.map((draft) => draft.productRef));
  const productRows = byId(
    productIds.length === 0 ? [] : await client.searchRead("product.product", withArchived(productIds), ["name", "default_code", "uom_id", "type", "location_type", "active"]),
  );
  const goods = drafts.filter((draft) => {
    const product = productRows.get(draft.productRef);
    return product !== undefined && product.type !== "service";
  });

  const partnerIds = uniqueSorted(goods.map((draft) => draft.partnerRef));
  const partnerRows = byId(
    partnerIds.length === 0 ? [] : await client.searchRead("res.partner", withArchived(partnerIds), ["name", "ref", "street", "street2", "city", "active"]),
  );
  const kept = goods.filter((draft) => partnerRows.has(draft.partnerRef));

  const writeDates = [...purchaseHeaders, ...saleHeaders].map((header) => textOrNull(header.write_date)).filter((value) => value !== null);
  return {
    contracts: kept,
    productRows,
    partnerRows,
    skipped: purchaseLines.length + saleLines.length - kept.length,
    /** "YYYY-MM-DD HH:MM:SS" sorts as text. */
    newestWriteDate: writeDates.length === 0 ? null : writeDates.reduce((a, b) => (a > b ? a : b)),
  };
}

async function writeToDatabase(tx: Orm, read: Awaited<ReturnType<typeof readFromOdoo>>, now: Date) {
  const refs = <T>(rows: T[], ref: (row: T) => number) => uniqueSorted(rows.map(ref)).map(String);
  let partnerCount = 0;
  let productCount = 0;
  let contractCount = 0;

  const partnerValues = refs(read.contracts, (draft) => draft.partnerRef).map((erpRef) => {
    const row = read.partnerRows.get(Number(erpRef)) as OdooRecord;
    const address = [row.street, row.street2, row.city].map(textOrNull).filter((part) => part !== null);
    const seenOn = (direction: "IN" | "OUT") => read.contracts.some((draft) => String(draft.partnerRef) === erpRef && draft.direction === direction);
    return {
      erpSystem: "ODOO",
      erpRef,
      code: textOrNull(row.ref),
      name: textOrNull(row.name) ?? erpRef,
      address: address.length > 0 ? address.join(", ") : null,
      isSupplier: seenOn("IN"),
      isCustomer: seenOn("OUT"),
      isActive: row.active !== false,
      syncedAt: now,
      updatedAt: now,
    };
  });
  for (const values of chunks(partnerValues)) {
    const copied = [partners.code, partners.name, partners.address, partners.isActive];
    const changed = await tx
      .insert(partners)
      .values(values)
      .onConflictDoUpdate({
        target: [partners.erpSystem, partners.erpRef],
        set: {
          ...takeIncoming({ code: partners.code, name: partners.name, address: partners.address, isActive: partners.isActive, syncedAt: partners.syncedAt, updatedAt: partners.updatedAt }),
          // a flag that is set stays set: the partner may be a supplier on a contract this run did not read
          isSupplier: sql`"partners"."is_supplier" or excluded."is_supplier"`,
          isCustomer: sql`"partners"."is_customer" or excluded."is_customer"`,
        },
        setWhere: sql`${differs("partners", copied)} or (excluded."is_supplier" and not "partners"."is_supplier") or (excluded."is_customer" and not "partners"."is_customer")`,
      })
      .returning({ id: partners.id });
    partnerCount += changed.length;
  }

  const productValues = refs(read.contracts, (draft) => draft.productRef).map((erpRef) => {
    const row = read.productRows.get(Number(erpRef)) as OdooRecord;
    const name = textOrNull(row.name) ?? erpRef;
    const unit = many2one(row.uom_id)?.name ?? null;
    return {
      erpSystem: "ODOO",
      erpRef,
      code: textOrNull(row.default_code),
      name,
      uom: unit ?? "kg",
      category: categoryOf(name, textOrNull(row.location_type), unit),
      isActive: row.active !== false,
      syncedAt: now,
    };
  });
  for (const values of chunks(productValues)) {
    const changed = await tx
      .insert(products)
      .values(values)
      .onConflictDoUpdate({
        target: [products.erpSystem, products.erpRef],
        // category is not in this list: it is set on insert only
        set: takeIncoming({ code: products.code, name: products.name, uom: products.uom, isActive: products.isActive, syncedAt: products.syncedAt }),
        setWhere: differs("products", [products.code, products.name, products.uom, products.isActive]),
      })
      .returning({ id: products.id });
    productCount += changed.length;
  }

  const idsByRef = async (table: typeof partners | typeof products, wanted: string[]) => {
    const found = new Map<string, number>();
    for (const part of chunks(wanted, 5000)) {
      const rows = await tx.select({ id: table.id, erpRef: table.erpRef }).from(table).where(and(eq(table.erpSystem, "ODOO"), inArray(table.erpRef, part)));
      for (const row of rows) if (row.erpRef !== null) found.set(row.erpRef, row.id);
    }
    return found;
  };
  const partnerIds = await idsByRef(partners, partnerValues.map((row) => row.erpRef));
  const productIds = await idsByRef(products, productValues.map((row) => row.erpRef));

  const contractValues = read.contracts.map((draft) => ({
    erpSystem: "ODOO",
    erpRef: draft.erpRef,
    direction: draft.direction,
    contractNo: draft.contractNo,
    partnerId: partnerIds.get(String(draft.partnerRef)) as number,
    productId: productIds.get(String(draft.productRef)) as number,
    qtyContract: draft.qtyContract,
    qtyDoneErp: draft.qtyDoneErp,
    customerPoNo: draft.customerPoNo,
    contractDate: draft.contractDate,
    uom: draft.uom ?? productValues.find((row) => row.erpRef === String(draft.productRef))?.uom ?? "kg",
    tolerancePct: draft.tolerancePct,
    certificate: draft.certificate,
    validFrom: draft.contractDate,
    validUntil: draft.validUntil,
    state: draft.state,
    raw: draft.raw,
    syncedAt: now,
  }));
  for (const values of chunks(contractValues)) {
    const c = erpContracts;
    const copied = {
      direction: c.direction, contractNo: c.contractNo, partnerId: c.partnerId, productId: c.productId, qtyContract: c.qtyContract,
      qtyDoneErp: c.qtyDoneErp, customerPoNo: c.customerPoNo, contractDate: c.contractDate, uom: c.uom, tolerancePct: c.tolerancePct,
      certificate: c.certificate, validFrom: c.validFrom, validUntil: c.validUntil, state: c.state, raw: c.raw,
    };
    const changed = await tx
      .insert(erpContracts)
      .values(values)
      .onConflictDoUpdate({
        target: [c.erpSystem, c.erpRef],
        // qty_opening and site_id are set in this application and are not touched
        set: takeIncoming({ ...copied, syncedAt: c.syncedAt }),
        setWhere: differs("erp_contracts", Object.values(copied)),
      })
      .returning({ id: c.id });
    contractCount += changed.length;
  }

  return { contracts: contractCount, partners: partnerCount, products: productCount };
}

/**
 * One sync run. Writes an erp_sync_runs row (entity CONTRACT) whose cursor is the newest header write_date
 * seen so far. On failure nothing of the run is kept except that row, marked FAILED with the error text.
 */
export async function syncOdoo(database: Database, client: OdooClient, now: () => Date): Promise<SyncResult> {
  const orm = database.db;
  const started = performance.now();
  const [run] = await orm.insert(erpSyncRuns).values({ erpSystem: "ODOO", entity: "CONTRACT", startedAt: now() }).returning({ id: erpSyncRuns.id });
  if (!run) throw new Error("The sync run could not be recorded.");
  try {
    const [last] = await orm
      .select({ cursor: erpSyncRuns.cursorValue })
      .from(erpSyncRuns)
      .where(and(eq(erpSyncRuns.erpSystem, "ODOO"), eq(erpSyncRuns.entity, "CONTRACT"), eq(erpSyncRuns.status, "OK"), isNotNull(erpSyncRuns.cursorValue)))
      .orderBy(desc(erpSyncRuns.id))
      .limit(1);
    const cursor = last?.cursor ?? null;

    const read = await readFromOdoo(client, cursor);
    const counts = await orm.transaction(async (tx) => {
      const written = await writeToDatabase(tx, read, now());
      await tx
        .update(erpSyncRuns)
        .set({ status: "OK", finishedAt: now(), cursorValue: read.newestWriteDate ?? cursor, rowsUpserted: written.contracts })
        .where(eq(erpSyncRuns.id, run.id));
      return written;
    });
    return { ...counts, skipped: read.skipped, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await orm.update(erpSyncRuns).set({ status: "FAILED", finishedAt: now(), error: text }).where(eq(erpSyncRuns.id, run.id));
    throw error;
  }
}
