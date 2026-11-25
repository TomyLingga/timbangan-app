// The registration post for a truck that arrives without an SPJ barcode, with only its paper: the surat pengantar
// of the mill (incoming) or the delivery order (outgoing). The post scans the paper; the document reading service
// reads it; this API matches the reading against its own master data and proposes a registration; the operator
// corrects and confirms it; one request then registers the truck, keeps the scan with it, and checks it in.
//
// The post does not type registrations (owner's decision, 25 November 2026). The exception is the emergency path:
// when the scan was not read (the reading service is down, the paper is unreadable) or there is no scan at all,
// an account that holds the module gate_emergency may type the registration, with a reason that is audited.
//
// The reading service gets the image only. Its answer and the image hold names and licence numbers, so the log
// lines here carry sizes, counts and timings, never values.
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { linkedAnywhere } from "../attachments/routes.js";
import { SCAN_LABEL } from "../attachments/view.js";
import { accountOf, can, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { files, gateScans, registrations, spjDocuments, tripFiles, trips, users } from "../db/schema.js";
import { pushNewDriver } from "../drivers/create.js";
import { AppError, forbidden, invalid, notConfigured, refused } from "../errors.js";
import { imageTypeOf, notMultipart, storeFile } from "../files/routes.js";
import { idNumber, todayAtPlant } from "../http.js";
import { mayWrite, registrationBody, submitRegistration, writeRegistration } from "../registrations/service.js";
import { loadRegistrations } from "../registrations/view.js";
import { loadTrips } from "../trips/view.js";
import { OcrError, type OcrReading, readDocument } from "./ocr-client.js";
import { buildProposal } from "./proposal.js";
import { checkInRefusal, checkInWithCard, uidField } from "./routes.js";

/** A scan at 300 dpi of a legal-size page stays far below this. */
export const MAX_SCAN_BYTES = 15 * 1024 * 1024;
const SCAN_TYPES = new Set(["image/jpeg", "image/png"]);

const directionField = z.enum(["IN", "OUT"]);
const REASON_MESSAGE = "Alasan registrasi darurat wajib diisi, 3 sampai 300 huruf.";
const walkInBody = z.object({
  // absent only on the emergency path, when there is no scan at all
  scanFileId: idNumber.optional(),
  cardUid: uidField,
  registration: registrationBody,
  emergencyReason: z.string(REASON_MESSAGE).trim().min(3, REASON_MESSAGE).max(300, REASON_MESSAGE).optional(),
});

/** Why a walk-in counts as typed by hand; null when it rests on a scan the service read. */
type TypedCause = "NO_SCAN" | "NOT_READ" | "UNREADABLE" | null;
const EMERGENCY_MESSAGES: Record<Exclude<TypedCause, null>, string> = {
  NO_SCAN: "Registrasi tanpa scan dokumen hanya untuk petugas dengan akses registrasi darurat.",
  NOT_READ: "Dokumen ini belum terbaca oleh layanan baca dokumen. Pindai lagi, atau minta petugas dengan akses registrasi darurat.",
  UNREADABLE: "Dokumen ini tidak terbaca. Pindai lagi, atau minta petugas dengan akses registrasi darurat.",
};

const scanTooLarge = () => new AppError(413, "FILE_TOO_LARGE", "Scan paling besar 15 MB.");

/** What the post is told when the reading service could not be used; the scan is stored by then. */
function readingFailed(error: OcrError, timeoutMs: number, scanFileId: number): AppError {
  const kept = "Scan sudah disimpan. Coba pindai lagi.";
  if (error.kind === "TIMEOUT") {
    return new AppError(504, "OCR_TIMEOUT", `Layanan baca dokumen tidak menjawab dalam ${Math.round(timeoutMs / 1000)} detik. ${kept}`, undefined, { scanFileId });
  }
  if (error.kind === "FAILED") {
    return new AppError(502, "OCR_FAILED", `Layanan baca dokumen sedang bermasalah (HTTP ${error.status}). ${kept}`, undefined, { scanFileId });
  }
  return new AppError(502, "OCR_UNAVAILABLE", `Layanan baca dokumen tidak dapat dihubungi. ${kept}`, undefined, { scanFileId });
}

/**
 * Runs a step of the registration service. Its checks name the fields of the registration body; in a walk-in
 * that body sits one level down, so the field paths get the prefix the rest of the walk-in body's messages have.
 */
async function underRegistration<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION" && error.fields) {
      throw new AppError(error.status, error.code, error.message, error.fields.map((item) => ({ ...item, field: `registration.${item.field}` })));
    }
    throw error;
  }
}

/**
 * Locks the scan a walk-in refers to: a file POST /api/gate/scan-document stored (a staff upload of kind SCAN)
 * that is not attached to anything yet. Answers the file and why a registration built on it counts as typed.
 */
async function lockScan(tx: Orm, scanFileId: number, direction: "IN" | "OUT"): Promise<{ id: number; typed: TypedCause }> {
  const [file] = await tx.select({ id: files.id, kind: files.kind, uploadedBy: files.uploadedBy }).from(files).where(eq(files.id, scanFileId)).for("update");
  const [uploader] = file?.uploadedBy != null ? await tx.select({ kind: users.kind }).from(users).where(eq(users.id, file.uploadedBy)) : [];
  if (!file || file.kind !== "SCAN" || uploader?.kind !== "INTERNAL") throw invalid("scanFileId", "Scan dokumen tidak ditemukan.");
  if (await linkedAnywhere(tx, file.id)) throw refused("SCAN_ALREADY_USED", "Scan ini sudah dipakai untuk registrasi lain.");
  const [scan] = await tx.select({ direction: gateScans.direction, outcome: gateScans.outcome }).from(gateScans).where(eq(gateScans.fileId, file.id));
  if (scan && scan.direction !== direction) throw invalid("scanFileId", "Scan ini dipindai untuk arah yang lain.");
  return { id: file.id, typed: !scan || scan.outcome === "NOT_READ" ? "NOT_READ" : scan.outcome === "UNREADABLE" ? "UNREADABLE" : null };
}

export function registerWalkInRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  // the proposal shows contracts and drivers of every company, so partner accounts never get here
  const scanners = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("gate", "CREATE")] };
  // a walk-in is a registration and a check-in at once: it needs what each of the two routes needs
  const registrars = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("gate", "CREATE"), guards.requirePermission("registrations", "CREATE")] };

  app.post("/api/gate/scan-document", scanners, async (request) => {
    const ocr = context.config.ocr;
    if (!ocr) throw notConfigured("Layanan baca dokumen");
    if (!request.isMultipart()) throw notMultipart();
    const account = accountOf(request);
    let bytes: Buffer | null = null;
    let originalName: string | null = null;
    let typedDirection: unknown;
    try {
      // the fields may come before or after the file
      for await (const part of request.parts({ limits: { fileSize: MAX_SCAN_BYTES } })) {
        if (part.type === "file") {
          bytes = await part.toBuffer();
          originalName = part.filename ? part.filename.slice(0, 200) : null;
        } else if (part.fieldname === "direction") typedDirection = part.value;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") throw scanTooLarge();
      throw notMultipart();
    }
    if (!bytes) throw invalid("file", "Pilih satu berkas scan.");
    const parsed = directionField.safeParse(typedDirection);
    if (!parsed.success) throw invalid("direction", "Arah harus IN atau OUT.");
    const direction = parsed.data;
    const type = imageTypeOf(bytes);
    if (!type || !SCAN_TYPES.has(type.mime)) throw invalid("file", "Scan harus gambar JPG atau PNG.");

    // the scan is kept whatever the reading service then does with it
    const now = context.now();
    const fileId = await storeFile(context, { bytes, type, originalName, kind: "SCAN", uploadedBy: account.id }, now);
    const sizeBytes = bytes.length;
    // the outcome is kept with the scan: a walk-in on a scan that was not read is the emergency path
    const audit = async (outcome: string, reading?: OcrReading) => {
      await orm.insert(gateScans).values({
        fileId,
        direction,
        outcome: !reading ? "NOT_READ" : reading.unreadable ? "UNREADABLE" : "READ",
        fieldsFound: reading?.fieldsFound ?? null,
        fieldsTotal: reading?.fieldsTotal ?? null,
      });
      await writeAudit(orm, request, now, {
        action: "DOCUMENT_SCANNED",
        entityType: "file",
        entityId: fileId,
        before: null,
        after: { direction, outcome, fieldsFound: reading?.fieldsFound ?? null, fieldsTotal: reading?.fieldsTotal ?? null },
      });
    };

    let reading: OcrReading;
    try {
      reading = await readDocument(ocr, direction, { bytes, mimeType: type.mime });
    } catch (error) {
      if (!(error instanceof OcrError)) throw error;
      request.log.warn({ fileId, direction, sizeBytes, ocrMs: error.ms, reason: error.kind, status: error.status }, "document reading failed");
      const failure = readingFailed(error, ocr.timeoutMs, fileId);
      await audit(failure.code);
      throw failure;
    }
    const started = performance.now();
    const proposal = await buildProposal(orm, direction, reading, now);
    await audit(reading.unreadable ? "UNREADABLE" : "READ", reading);
    request.log.info(
      {
        fileId,
        direction,
        sizeBytes,
        ocrMs: reading.ms,
        matchMs: Math.round(performance.now() - started),
        fieldsFound: reading.fieldsFound,
        fieldsTotal: reading.fieldsTotal,
        flagged: reading.fields.filter((field) => field.needsCheck).length,
        unreadable: reading.unreadable,
        missing: proposal.missing.length,
      },
      "document scanned",
    );
    return { scan: { fileId, originalName, mimeType: type.mime, sizeBytes }, ...proposal, timing: { ocrMs: reading.ms } };
  });

  app.post("/api/gate/walk-in", registrars, async (request: FastifyRequest, reply) => {
    const body = walkInBody.parse(request.body);
    const account = accountOf(request);
    if (!mayWrite(account, body.registration.direction)) throw forbidden();
    if (!body.registration.submit) throw invalid("registration.submit", "Registrasi di pos selalu langsung dikirim (submit: true).");
    const [truck] = body.registration.trips;
    if (!truck || body.registration.trips.length !== 1) throw invalid("registration.trips", "Registrasi di pos berisi tepat satu truk.");
    if (body.registration.direction === "OUT") {
      // without it the whole remainder of the DO would be planned on this one truck
      const open = body.registration.allocations.findIndex((allocation) => allocation.qtyPlanned === undefined);
      if (open !== -1) throw invalid(`registration.allocations.${open}.qtyPlanned`, "Isi quantity yang dimuat truk ini.");
    }
    const now = context.now();
    // the truck stands at the post: it arrives today, whatever the request says
    const today = todayAtPlant(now);
    const registration = { ...body.registration, plannedDate: today, trips: [{ ...truck, plannedArrival: today }] };

    let outcome: { registrationId: number; tripId: number; checkedIn: boolean; emergency: boolean; newDrivers: number[] };
    try {
      outcome = await orm.transaction(async (tx) => {
        const scan = body.scanFileId === undefined ? null : await lockScan(tx, body.scanFileId, registration.direction);
        const typed: TypedCause = scan === null ? "NO_SCAN" : scan.typed;
        if (typed !== null) {
          if (!can(account, "gate_emergency", "VIEW")) throw new AppError(403, "EMERGENCY_ACCESS_REQUIRED", EMERGENCY_MESSAGES[typed]);
          if (body.emergencyReason === undefined) throw invalid("emergencyReason", REASON_MESSAGE);
        }
        // a typed registration is marked as the operator's own, not as one made from a scan
        const written = await underRegistration(() => writeRegistration(tx, account, registration, now, undefined, typed === null ? "SCAN" : undefined));
        await underRegistration(() => submitRegistration(tx, written.id, account.id, now));
        const [stored] = await tx.select({ status: registrations.status }).from(registrations).where(eq(registrations.id, written.id));
        const [trip] = await tx.select({ id: trips.id }).from(trips).where(eq(trips.registrationId, written.id));
        if (!stored || !trip) throw new Error(`Registration ${written.id} was not written.`);
        if (scan) {
          await tx.insert(tripFiles).values({ tripId: trip.id, fileId: scan.id, label: SCAN_LABEL, addedBy: account.id, addedAt: now });
          await writeAudit(tx, request, now, { action: "TRIP_SCAN_ADDED", entityType: "registration", entityId: written.id, before: null, after: { tripId: trip.id, fileId: scan.id } });
        }
        if (typed !== null && body.emergencyReason !== undefined) {
          await writeAudit(tx, request, now, {
            action: "WALK_IN_EMERGENCY",
            entityType: "registration",
            entityId: written.id,
            before: null,
            after: { tripId: trip.id, cause: typed, fileId: scan?.id ?? null },
            reason: body.emergencyReason,
          });
        }
        // approved at once: the SPJ exists and the truck goes in. Waiting for review: no SPJ, no check-in.
        const [spj] = stored.status === "APPROVED" ? await tx.select().from(spjDocuments).where(and(eq(spjDocuments.tripId, trip.id), isNull(spjDocuments.revokedAt))) : [];
        if (stored.status === "APPROVED" && !spj) throw new Error(`Registration ${written.id} was approved without an SPJ.`);
        // the operator marked close cargo and flexi bag in the same form
        if (spj) await underRegistration(() => checkInWithCard(tx, request, now, spj, body.cardUid, registration));
        return { registrationId: written.id, tripId: trip.id, checkedIn: spj !== undefined, emergency: typed !== null, newDrivers: written.newDrivers };
      });
    } catch (error) {
      // two walk-ins at the same moment for one card or one truck: the unique indexes stop the second one
      throw checkInRefusal(error) ?? error;
    }
    // as POST /api/registrations: a driver entered in place goes to the registry once the registration is committed
    for (const id of outcome.newDrivers) await pushNewDriver(context, id, request.log);

    const [shown] = await loadRegistrations(orm, [outcome.registrationId]);
    const [trip] = outcome.checkedIn ? await loadTrips(orm, [outcome.tripId]) : [];
    return reply.code(201).send({
      state: outcome.checkedIn ? "CHECKED_IN" : "REVIEW",
      emergency: outcome.emergency,
      message: outcome.checkedIn ? null : "Registrasi menunggu tinjauan logistik. Truk belum check-in dan kartu belum dipakai.",
      registration: shown,
      trip: trip ?? null,
    });
  });
}
