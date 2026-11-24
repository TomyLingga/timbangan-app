// The opening balance of the contracts at the cut-over: what was realised before this application took over. The
// reports and the registration checks subtract qty_opening from the contract quantity.
//
// Outgoing lines: until the cut-over the old application recorded every delivery in Odoo, so Odoo's delivered
// quantity (qty_done_erp) is the opening. Lines without it keep the opening they have.
// Incoming lines: Odoo's purchase-contract line holds no received quantity, so the opening is the summed net of the
// completed incoming trucks in the archive whose reference is the contract number (trimmed, any case). A contract
// with one line takes the whole sum; with several, each line takes the trucks whose product name equals its
// product's name (any case). Lines not in kilograms are skipped. Nets of zero, below zero or empty are left out.
//
// A real run needs a full Odoo sync (`npm run sync:odoo -- --full`) less than an hour old, unless staleOk.
import type { Database } from "../db/client.js";
import { FULL_SYNC_SETTING } from "../odoo/sync.js";

export const CUTOVER_SETTING = "cutover_opening";
/** How old the last full Odoo sync may be. */
export const FRESH_SYNC_MS = 60 * 60 * 1000;

export interface IncomingCounts {
  lines: number;
  /** Lines given a sum from the archive. */
  set: number;
  /** Kilogram lines nothing in the archive matched: their opening is 0. */
  zero: number;
  notKg: number;
  /** Completed incoming archive trucks whose net is zero, below zero or empty. */
  leftOutTrips: number;
  /** Trucks of a contract with several lines whose product matched no line, or more than one. */
  unattributedTrips: number;
  unattributedKg: number;
  /** Archive references that are no contract number here, and the trucks behind them. */
  unmatchedReferences: number;
  unmatchedTrips: number;
}

export interface OutgoingCounts {
  lines: number;
  set: number;
  withoutErp: number;
}

export interface CutoverResult {
  dryRun: boolean;
  /** When an earlier run set the openings; null before the first. */
  previous: string | null;
  /** Why the ERP figures may be old, on a dry run or with staleOk; null when a full sync is fresh. */
  staleWarning: string | null;
  incoming: IncomingCounts;
  outgoing: OutgoingCounts;
  /** Lines whose opening differs (or on a dry run would differ) from before. */
  changed: number;
  /** The summed opening of the lines that were set, per direction and unit. */
  totals: { direction: string; uom: string; qty: number }[];
}

export class CutoverRefused extends Error {
  override name = "CutoverRefused";
}

interface Line {
  id: number;
  direction: "IN" | "OUT";
  contract_no: string;
  uom: string;
  product_name: string;
  qty_opening: number;
  qty_done_erp: number | null;
}

interface ArchiveGroup {
  ref: string;
  product: string;
  trips: number;
  kg: number;
  left_out: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const isKg = (uom: string) => uom.trim().toLowerCase() === "kg";
const key = (text: string) => text.trim().toUpperCase();

/** Why the ERP figures cannot be trusted as fresh, or null. */
async function staleness(database: Pick<Database, "query">, now: Date): Promise<string | null> {
  const [row] = await database.query<{ at: string | null }>("select value->>'at' as at from settings where site_id is null and key = $1", [FULL_SYNC_SETTING]);
  const advice = "Jalankan dulu npm run sync:odoo -- --full, atau tambahkan --stale-ok bila angka Odoo yang ada memang yang dipakai.";
  if (!row?.at) return `Belum pernah ada sinkron penuh Odoo. ${advice}`;
  if (now.getTime() - new Date(row.at).getTime() > FRESH_SYNC_MS) return `Sinkron penuh Odoo terakhir ${row.at}, lebih dari satu jam lalu. ${advice}`;
  return null;
}

export async function cutoverOpening(database: Database, options: { dryRun?: boolean; again?: boolean; staleOk?: boolean }, now: () => Date): Promise<CutoverResult> {
  return database.transaction(async (tx) => {
    // one run at a time: the second waits here and then sees the first one's record
    await tx.query("lock table erp_contracts in share row exclusive mode");
    const at = now();
    const [record] = await tx.query<{ at: string | null }>("select value->>'at' as at from settings where site_id is null and key = $1", [CUTOVER_SETTING]);
    const previous = record?.at ?? null;
    if (previous !== null && !options.dryRun && !options.again) {
      throw new CutoverRefused(`Saldo awal sudah diisi pada ${previous}. Jalankan lagi dengan --again bila memang ingin mengambil angka yang sekarang.`);
    }
    const stale = await staleness(tx, at);
    if (stale !== null && !options.dryRun && !options.staleOk) throw new CutoverRefused(stale);

    const lines = await tx.query<Line>(
      `select c.id::float8 as id, c.direction, c.contract_no, c.uom, p.name as product_name, c.qty_opening::float8 as qty_opening, c.qty_done_erp::float8 as qty_done_erp
       from erp_contracts c join products p on p.id = c.product_id order by c.id`,
    );
    const groups = await tx.query<ArchiveGroup>(
      `select upper(btrim(reference)) as ref, lower(btrim(coalesce(product_name, ''))) as product,
              count(*) filter (where net_kg > 0)::int as trips, coalesce(sum(net_kg) filter (where net_kg > 0), 0)::float8 as kg,
              count(*) filter (where net_kg is null or net_kg <= 0)::int as left_out
       from legacy_trips
       where state = 'COMPLETED' and direction = 'IN' and btrim(coalesce(reference, '')) <> ''
       group by 1, 2`,
    );

    const incoming: IncomingCounts = { lines: 0, set: 0, zero: 0, notKg: 0, leftOutTrips: 0, unattributedTrips: 0, unattributedKg: 0, unmatchedReferences: 0, unmatchedTrips: 0 };
    const outgoing: OutgoingCounts = { lines: 0, set: 0, withoutErp: 0 };
    const byContract = new Map<string, Line[]>();
    for (const line of lines) {
      if (line.direction !== "IN") continue;
      const list = byContract.get(key(line.contract_no));
      if (list) list.push(line);
      else byContract.set(key(line.contract_no), [line]);
    }

    const sums = new Map<number, number>();
    const unmatched = new Set<string>();
    for (const group of groups) {
      incoming.leftOutTrips += group.left_out;
      const candidates = byContract.get(group.ref);
      if (!candidates) {
        unmatched.add(group.ref);
        incoming.unmatchedTrips += group.trips + group.left_out;
        continue;
      }
      if (group.trips === 0) continue;
      const matching = candidates.length === 1 ? candidates : candidates.filter((line) => line.product_name.trim().toLowerCase() === group.product);
      const target = matching.length === 1 ? matching[0] : undefined;
      if (!target) {
        incoming.unattributedTrips += group.trips;
        incoming.unattributedKg += group.kg;
        continue;
      }
      // trucks of a line that is not in kilograms are not summed: that line is skipped
      if (isKg(target.uom)) sums.set(target.id, (sums.get(target.id) ?? 0) + group.kg);
    }
    incoming.unmatchedReferences = unmatched.size;

    const updates: { id: number; qty: number }[] = [];
    const totals = new Map<string, { direction: string; uom: string; qty: number }>();
    const addTotal = (direction: string, uom: string, qty: number) => {
      const name = `${direction} ${uom}`;
      const total = totals.get(name) ?? { direction, uom, qty: 0 };
      total.qty = round3(total.qty + qty);
      totals.set(name, total);
    };
    for (const line of lines) {
      let qty: number | null = null;
      if (line.direction === "IN") {
        incoming.lines++;
        if (!isKg(line.uom)) {
          incoming.notKg++;
          continue;
        }
        qty = round3(sums.get(line.id) ?? 0);
        if (qty > 0) {
          incoming.set++;
          addTotal("IN", "kg", qty);
        } else incoming.zero++;
      } else {
        outgoing.lines++;
        if (line.qty_done_erp === null) {
          outgoing.withoutErp++;
          continue;
        }
        qty = round3(line.qty_done_erp);
        outgoing.set++;
        addTotal("OUT", line.uom, qty);
      }
      if (qty !== round3(line.qty_opening)) updates.push({ id: line.id, qty });
    }

    const result: CutoverResult = {
      dryRun: options.dryRun === true,
      previous,
      staleWarning: stale,
      incoming,
      outgoing,
      changed: updates.length,
      totals: [...totals.values()].sort((a, b) => a.direction.localeCompare(b.direction) || a.uom.localeCompare(b.uom)),
    };
    if (options.dryRun) return result;

    if (updates.length > 0) {
      await tx.query("update erp_contracts c set qty_opening = r.qty from jsonb_to_recordset($1::jsonb) as r(id bigint, qty numeric) where c.id = r.id", [JSON.stringify(updates)]);
    }
    const value = { at: at.toISOString(), in: incoming, out: outgoing, changed: updates.length };
    if (record) await tx.query("update settings set value = $2::jsonb, updated_at = $3::timestamptz where site_id is null and key = $1", [CUTOVER_SETTING, JSON.stringify(value), value.at]);
    else await tx.query("insert into settings (site_id, key, value, updated_at) values (null, $1, $2::jsonb, $3::timestamptz)", [CUTOVER_SETTING, JSON.stringify(value), value.at]);
    return result;
  });
}
