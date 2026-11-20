// Copies the central driver registry into `drivers` and its transporters into `partners`. Read-only on the
// registry side. A driver that exists here but not in the registry is left as it is.
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import type { Database, Orm } from "../db/client.js";
import { drivers, erpSyncRuns, partners } from "../db/schema.js";
import { lettersAndDigits } from "../http.js";
import { datePart, textOrNull } from "../odoo/values.js";
import type { RegistryRecord, VcfClient } from "./client.js";

export interface VcfSyncResult {
  /** Rows inserted or changed in this run. */
  drivers: number;
  transporters: number;
  /** Registry rows that were not copied: no usable licence number or name, a duplicate, a conflict. */
  skipped: number;
  durationMs: number;
}

type RegistryStatus = "UNKNOWN" | "NORMAL" | "WARNING" | "BLACKLIST";
/** Higher is worse. Of two registry rows with one licence number the worse one is kept. */
const SEVERITY: Record<RegistryStatus, number> = { UNKNOWN: 0, NORMAL: 1, WARNING: 2, BLACKLIST: 3 };
/** The check constraint of drivers.licence_no. */
const LICENCE = /^[A-Z0-9]{6,20}$/;
const TRANSPORTER_CODE = "VCF-";

interface DriverCandidate {
  registryRef: string;
  fullName: string;
  licenceNo: string;
  licenceClass: string | null;
  licenceValidUntil: string | null;
  registryStatus: RegistryStatus;
  isActive: boolean;
}

const refOf = (row: RegistryRecord) => (typeof row.id === "number" || typeof row.id === "string" ? String(row.id) : null);
/** The registry sends a flag as true/false or 1/0; a missing flag means active. */
const activeOf = (row: RegistryRecord) => !(row.is_active === false || row.is_active === 0 || row.is_active === "0");

function statusOf(value: unknown): RegistryStatus {
  const status = String(value ?? "").toUpperCase();
  return status === "NORMAL" || status === "WARNING" || status === "BLACKLIST" ? status : "UNKNOWN";
}

function* chunks<T>(rows: T[], size = 500): Generator<T[]> {
  for (let start = 0; start < rows.length; start += size) yield rows.slice(start, start + size);
}

/** One candidate per licence number; the rest is counted as skipped. */
function driverCandidates(rows: RegistryRecord[]): { candidates: DriverCandidate[]; skipped: number } {
  const byLicence = new Map<string, DriverCandidate>();
  let skipped = 0;
  for (const row of rows) {
    const registryRef = refOf(row);
    const fullName = textOrNull(row.nama_supir)?.trim();
    const licenceNo = lettersAndDigits(typeof row.no_sim === "string" ? row.no_sim : "");
    if (!registryRef || !fullName || !LICENCE.test(licenceNo)) {
      skipped++;
      continue;
    }
    const candidate: DriverCandidate = {
      registryRef,
      fullName,
      licenceNo,
      licenceClass: textOrNull(row.jenis_sim),
      licenceValidUntil: datePart(row.tgl_berlaku_sim),
      registryStatus: statusOf(row.status),
      isActive: activeOf(row),
    };
    const other = byLicence.get(licenceNo);
    if (other) skipped++;
    if (!other || SEVERITY[candidate.registryStatus] > SEVERITY[other.registryStatus]) byLicence.set(licenceNo, candidate);
  }
  return { candidates: [...byLicence.values()], skipped };
}

async function writeDrivers(tx: Orm, candidates: DriverCandidate[], now: Date): Promise<{ written: number; skipped: number }> {
  const existing = await tx
    .select({
      id: drivers.id, fullName: drivers.fullName, licenceNo: drivers.licenceNo, licenceClass: drivers.licenceClass, licenceValidUntil: drivers.licenceValidUntil,
      registryRef: drivers.registryRef, registryStatus: drivers.registryStatus, registryPush: drivers.registryPush, isActive: drivers.isActive,
    })
    .from(drivers);
  const byRef = new Map(existing.filter((row) => row.registryRef !== null).map((row) => [row.registryRef as string, row]));
  const byLicence = new Map(existing.map((row) => [row.licenceNo, row]));

  const fresh: DriverCandidate[] = [];
  const seen = new Set<number>();
  let written = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const sameLicence = byLicence.get(candidate.licenceNo);
    // by registry id first; by licence number only when that driver is not tied to another registry id
    const match = byRef.get(candidate.registryRef) ?? (sameLicence && (sameLicence.registryRef === null || sameLicence.registryRef === candidate.registryRef) ? sameLicence : undefined);
    if (!match) {
      if (sameLicence) skipped++;
      else fresh.push(candidate);
      continue;
    }
    if (seen.has(match.id)) {
      skipped++;
      continue;
    }
    seen.add(match.id);
    const { licenceNo: _kept, ...copied } = candidate;
    const changed = match.registryPush !== "NONE" || (Object.keys(copied) as (keyof typeof copied)[]).some((key) => match[key] !== copied[key]);
    if (changed) {
      // the licence number stored here stays; a driver the registry knows no longer waits to be sent to it
      await tx.update(drivers).set({ ...copied, registryPush: "NONE", updatedAt: now }).where(eq(drivers.id, match.id));
      written++;
    }
  }
  for (const part of chunks(fresh)) {
    await tx.insert(drivers).values(part.map((candidate) => ({ ...candidate, registrySyncedAt: now })));
    written += part.length;
  }
  // every driver the registry confirmed carries the time of this run, changed or not
  for (const part of chunks([...seen], 5000)) await tx.update(drivers).set({ registrySyncedAt: now }).where(inArray(drivers.id, part));
  return { written, skipped };
}

async function writeTransporters(tx: Orm, rows: RegistryRecord[], now: Date): Promise<{ written: number; skipped: number }> {
  // only rows of our own: a partner copied from the ERP is never matched, whatever its code
  const existing = await tx
    .select({ id: partners.id, code: partners.code, name: partners.name, isActive: partners.isActive, isTransporter: partners.isTransporter })
    .from(partners)
    .where(and(isNull(partners.erpSystem), like(partners.code, `${TRANSPORTER_CODE}%`)));
  const byCode = new Map(existing.map((row) => [row.code as string, row]));
  const seen = new Set<string>();
  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    const ref = refOf(row);
    const name = textOrNull(row.nama_transporter)?.trim();
    const code = `${TRANSPORTER_CODE}${ref}`;
    if (!ref || !name || seen.has(code)) {
      skipped++;
      continue;
    }
    seen.add(code);
    const isActive = activeOf(row);
    const match = byCode.get(code);
    if (!match) {
      await tx.insert(partners).values({ code, name, isTransporter: true, isActive });
      written++;
    } else if (match.name !== name || match.isActive !== isActive || !match.isTransporter) {
      await tx.update(partners).set({ name, isActive, isTransporter: true, updatedAt: now }).where(eq(partners.id, match.id));
      written++;
    }
  }
  return { written, skipped };
}

/**
 * One sync run. Writes two erp_sync_runs rows (VCF/DRIVER and VCF/PARTNER). Both lists are read before
 * anything is written; on failure nothing of the run is kept except those rows, marked FAILED.
 */
export async function syncVcf(database: Database, client: VcfClient, now: () => Date): Promise<VcfSyncResult> {
  const orm = database.db;
  const started = performance.now();
  const startRun = async (entity: "DRIVER" | "PARTNER") => {
    const [run] = await orm.insert(erpSyncRuns).values({ erpSystem: "VCF", entity, startedAt: now() }).returning({ id: erpSyncRuns.id });
    if (!run) throw new Error("The sync run could not be recorded.");
    return run.id;
  };
  const driverRun = await startRun("DRIVER");
  const partnerRun = await startRun("PARTNER");
  try {
    const registry = driverCandidates(await client.drivers());
    const transporterRows = await client.transporters();
    return await orm.transaction(async (tx) => {
      const at = now();
      const driversDone = await writeDrivers(tx, registry.candidates, at);
      const transportersDone = await writeTransporters(tx, transporterRows, at);
      const finish = (id: number, rowsUpserted: number) => tx.update(erpSyncRuns).set({ status: "OK", finishedAt: now(), rowsUpserted }).where(eq(erpSyncRuns.id, id));
      await finish(driverRun, driversDone.written);
      await finish(partnerRun, transportersDone.written);
      return {
        drivers: driversDone.written,
        transporters: transportersDone.written,
        skipped: registry.skipped + driversDone.skipped + transportersDone.skipped,
        durationMs: Math.round(performance.now() - started),
      };
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await orm.update(erpSyncRuns).set({ status: "FAILED", finishedAt: now(), error: text }).where(inArray(erpSyncRuns.id, [driverRun, partnerRun]));
    throw error;
  }
}
