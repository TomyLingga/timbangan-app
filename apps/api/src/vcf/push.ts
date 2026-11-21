// Sends drivers entered here (registry_push PENDING or FAILED, no registry id yet) to the central driver
// registry. Each driver ends SENT (with the registry id and status) or FAILED (with a short reason in
// registry_push_error). A problem with the account itself stops the run and leaves the other drivers as
// they were. The reasons are shown to staff, so they are short Indonesian text and never hold a secret.
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { drivers } from "../db/schema.js";
import { lettersAndDigits } from "../http.js";
import { type RegistryRecord, VcfAuthError, type VcfClient, VcfError, VcfLoginError } from "./client.js";
import { statusOf } from "./sync.js";

export interface PushResult {
  /** Drivers now SENT: added to the registry, or found there and linked. */
  pushed: number;
  /** Drivers marked FAILED in this run. */
  failed: number;
  /** Why the run stopped before the end; null when it went through. */
  stopped: string | null;
}

export interface PushOptions {
  /** Only this driver (the one just created). */
  driverId?: number;
  /** Aborts the calls to the registry, e.g. when a request may not wait longer. */
  signal?: AbortSignal;
}

/** Drivers sent in one run at most. */
export const PUSH_BATCH = 50;
const MAX_ERROR = 300;
export const FORBIDDEN_REASON = "Akun VCF tidak berhak menambah supir.";

type Candidate = Pick<typeof drivers.$inferSelect, "id" | "fullName" | "licenceNo" | "licenceClass" | "licenceValidUntil" | "isActive">;

/** Absent means normal; anything else as the read sync understands it. */
const pushedStatus = (value: unknown) => (value === undefined || value === null || value === "" ? "NORMAL" : statusOf(value));
const refOf = (row: RegistryRecord) => (typeof row.id === "number" || typeof row.id === "string" ? String(row.id) : null);

function failureReason(error: VcfError): string {
  if (error.timedOut) return "VCF tidak menjawab dalam batas waktu.";
  if (error.status !== undefined) return `VCF menjawab HTTP ${error.status}.`;
  return "VCF tidak dapat dihubungi.";
}

/** The reason a run stops for a problem with the account; null for an error that concerns one driver. */
function stopReason(error: VcfError): string | null {
  if (error instanceof VcfLoginError) {
    if (error.wrongCredentials) return "Login VCF ditolak: username atau password salah.";
    return `Login VCF gagal: ${failureReason(error)}`;
  }
  if (error instanceof VcfAuthError) return "VCF menolak token dari login yang baru. Pengiriman dihentikan.";
  return null;
}

function missingFields(driver: Candidate): string | null {
  const missing = [driver.licenceClass ? null : "Jenis SIM", driver.licenceValidUntil ? null : "masa berlaku SIM"].filter((item): item is string => item !== null);
  if (missing.length === 0) return null;
  const text = missing.join(" dan ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} belum diisi.`;
}

export async function pushPendingDrivers(database: Database, client: VcfClient, now: () => Date, options: PushOptions = {}): Promise<PushResult> {
  const result: PushResult = { pushed: 0, failed: 0, stopped: null };
  if (!client.canPush) return result;
  const orm = database.db;
  const queue = await orm
    .select({
      id: drivers.id,
      fullName: drivers.fullName,
      licenceNo: drivers.licenceNo,
      licenceClass: drivers.licenceClass,
      licenceValidUntil: drivers.licenceValidUntil,
      isActive: drivers.isActive,
    })
    .from(drivers)
    .where(and(inArray(drivers.registryPush, ["PENDING", "FAILED"]), isNull(drivers.registryRef), options.driverId === undefined ? undefined : eq(drivers.id, options.driverId)))
    .orderBy(asc(drivers.createdAt), asc(drivers.id))
    .limit(PUSH_BATCH);

  const fail = async (driver: Candidate, reason: string) => {
    const text = client.scrub(reason);
    await orm
      .update(drivers)
      .set({ registryPush: "FAILED", registryPushError: text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 3)}...` : text, updatedAt: now() })
      .where(eq(drivers.id, driver.id));
    result.failed++;
  };
  const link = async (driver: Candidate, record: RegistryRecord) => {
    const ref = refOf(record);
    if (!ref) return fail(driver, "VCF tidak mengirim id supir.");
    // registry_ref is unique: another driver here may already stand for this registry driver
    const [other] = await orm.select({ id: drivers.id }).from(drivers).where(and(eq(drivers.registryRef, ref), ne(drivers.id, driver.id)));
    if (other) return fail(driver, "Supir dengan nomor SIM ini di VCF sudah terhubung ke supir lain di sini.");
    const at = now();
    await orm
      .update(drivers)
      .set({ registryRef: ref, registryStatus: pushedStatus(record.status), registryPush: "SENT", registryPushError: null, registrySyncedAt: at, updatedAt: at })
      .where(eq(drivers.id, driver.id));
    result.pushed++;
  };

  for (const driver of queue) {
    const missing = missingFields(driver);
    if (missing) {
      await fail(driver, missing);
      continue;
    }
    try {
      const answer = await client.createDriver(
        {
          nama_supir: driver.fullName,
          no_sim: driver.licenceNo,
          jenis_sim: driver.licenceClass as string,
          tgl_berlaku_sim: driver.licenceValidUntil as string,
          is_active: driver.isActive,
        },
        options.signal,
      );
      if (answer.kind === "created") {
        await link(driver, answer.record);
      } else if (answer.kind === "forbidden") {
        await fail(driver, FORBIDDEN_REASON);
        result.stopped = FORBIDDEN_REASON;
        break;
      } else if (answer.fields.no_sim) {
        // the registry has this licence number already: find that driver and link it
        const found = (await client.searchDrivers(driver.licenceNo, options.signal)).find(
          (row) => typeof row.no_sim === "string" && lettersAndDigits(row.no_sim) === driver.licenceNo,
        );
        if (found) await link(driver, found);
        else await fail(driver, `VCF menolak: ${answer.fields.no_sim[0] ?? answer.message}`);
      } else {
        await fail(driver, `VCF menolak: ${answer.message}`);
      }
    } catch (error) {
      if (!(error instanceof VcfError)) throw error;
      const stop = stopReason(error);
      if (stop) {
        result.stopped = stop;
        break;
      }
      await fail(driver, failureReason(error));
    }
  }
  return result;
}
