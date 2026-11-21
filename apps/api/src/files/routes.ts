// Uploaded files: photos from the phones, the DO letter, and weighbridge slips. One file per request: a PDF up to
// 10 MB or an image (JPEG, PNG, WebP) up to 5 MB, typed by its first bytes and kept below the storage root under a
// random key. Forms and attachments then refer to the file by its id.
//
// Who reads a file: staff read every file. A partner account reads the uploads of its own company, and a staff
// upload once it is linked to that company's DO (sent to it) or to a truck slip of a registration it may see.
// Anyone else gets 404, never 403, so ids cannot be probed.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import multipart from "@fastify/multipart";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { type Account, accountOf, can, type Guards } from "../auth/guard.js";
import { SLIP_LABEL } from "../attachments/view.js";
import type { Orm } from "../db/client.js";
import { deliveryOrderFiles, deliveryOrders, files, registrations, tripFiles, trips, users } from "../db/schema.js";
import { AppError, forbidden, invalid, notFound } from "../errors.js";
import { idParams } from "../http.js";
import { plantDateParts } from "../numbering.js";
import { registrationsVisibleTo } from "../registrations/view.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** The largest part the multipart parser takes; images are held to MAX_IMAGE_BYTES after reading. */
export const MAX_FILE_BYTES = MAX_PDF_BYTES;

const FILE_TYPES = [
  { mime: "image/jpeg", ext: "jpg", image: true, matches: (head: Buffer) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { mime: "image/png", ext: "png", image: true, matches: (head: Buffer) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: "webp", image: true, matches: (head: Buffer) => head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP" },
  { mime: "application/pdf", ext: "pdf", image: false, matches: (head: Buffer) => head.toString("latin1", 0, 5) === "%PDF-" },
] as const;

/** The type of these bytes, from their signature; null for anything else. */
export const fileTypeOf = (bytes: Buffer) => FILE_TYPES.find((type) => type.matches(bytes)) ?? null;
/** The image type of these bytes; null for anything else (a PDF too). */
export const imageTypeOf = (bytes: Buffer) => FILE_TYPES.find((type) => type.image && type.matches(bytes)) ?? null;

const notMultipart = () => invalid("file", "Kirim satu berkas sebagai multipart/form-data.");
const tooLarge = () => new AppError(413, "FILE_TOO_LARGE", "Berkas paling besar 10 MB, gambar paling besar 5 MB.");

/** `inline` with an ASCII fallback name and the exact name in UTF-8 (RFC 6266). */
function disposition(name: string | null): string {
  const shown = name ?? "berkas";
  const ascii = shown.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(shown).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Whether a partner account may read this file (see the top of this file). */
async function partnerMayRead(orm: Orm, account: Account, fileId: number, uploadedBy: number | null): Promise<boolean> {
  const own = account.partner?.id ?? -1;
  if (uploadedBy !== null) {
    const [uploader] = await orm.select({ partnerId: users.partnerId }).from(users).where(eq(users.id, uploadedBy));
    if (uploader?.partnerId === own) return true;
  }
  const [onDo] = await orm
    .select({ id: deliveryOrders.id })
    .from(deliveryOrderFiles)
    .innerJoin(deliveryOrders, eq(deliveryOrders.id, deliveryOrderFiles.deliveryOrderId))
    .where(and(eq(deliveryOrderFiles.fileId, fileId), eq(deliveryOrders.transporterId, own), ne(deliveryOrders.status, "DRAFT")))
    .limit(1);
  if (onDo) return true;
  const [onTrip] = await orm
    .select({ id: trips.id })
    .from(tripFiles)
    .innerJoin(trips, eq(trips.id, tripFiles.tripId))
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .where(and(eq(tripFiles.fileId, fileId), eq(tripFiles.label, SLIP_LABEL), registrationsVisibleTo(account)))
    .limit(1);
  return onTrip !== undefined;
}

export async function registerFileRoutes(app: FastifyInstance, context: AppContext, guards: Guards): Promise<void> {
  const orm = context.database.db;
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10, parts: 11 } });

  /** Staff with any permission; a partner account with registrations CREATE (the supplier sending its slips). */
  const mayUpload = async (request: FastifyRequest) => {
    const account = accountOf(request);
    if (account.kind === "INTERNAL") return guards.requireInternal(request);
    if (!can(account, "registrations", "CREATE")) throw forbidden();
  };
  /** Any signed-in account; a staff account without permissions gets NO_ACCESS. The file decides the rest. */
  const mayAsk = async (request: FastifyRequest) => {
    if (accountOf(request).kind === "INTERNAL") await guards.requireInternal(request);
  };

  app.post("/api/files", { preHandler: [guards.authenticate, mayUpload] }, async (request, reply) => {
    if (!request.isMultipart()) throw notMultipart();
    const account = accountOf(request);
    let bytes: Buffer;
    let originalName: string | null;
    try {
      const part = await request.file();
      if (!part) throw invalid("file", "Pilih satu berkas.");
      bytes = await part.toBuffer();
      originalName = part.filename ? part.filename.slice(0, 200) : null;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
      throw notMultipart();
    }
    const type = fileTypeOf(bytes);
    if (!type) throw invalid("file", "Berkas harus PDF atau gambar JPEG, PNG, atau WebP.");
    if (type.image && bytes.length > MAX_IMAGE_BYTES) throw tooLarge();
    // a picture from a partner is a scan of a paper, never a photo a field form may take
    const kind = !type.image ? "PDF" : account.kind === "INTERNAL" ? "PHOTO" : "SCAN";

    const now = context.now();
    const { yyyy, mm } = plantDateParts(now);
    const storageKey = `${yyyy}/${mm}/${randomBytes(16).toString("hex")}.${type.ext}`;
    const path = join(context.config.files.dir, storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
    try {
      const [row] = await orm
        .insert(files)
        .values({
          storageKey,
          originalName,
          mimeType: type.mime,
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          kind,
          uploadedBy: account.id,
          createdAt: now,
        })
        .returning({ id: files.id });
      if (!row) throw new Error("The file was not recorded.");
      return reply.code(201).send({ id: row.id, originalName, mimeType: type.mime, sizeBytes: bytes.length });
    } catch (error) {
      // a file without its row would never be found again
      await unlink(path).catch(() => undefined);
      throw error;
    }
  });

  app.get("/api/files/:id", { preHandler: [guards.authenticate, mayAsk] }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const account = accountOf(request);
    const [row] = await orm.select().from(files).where(eq(files.id, id));
    if (!row) throw notFound("Berkas");
    if (account.kind === "PARTNER" && !(await partnerMayRead(orm, account, row.id, row.uploadedBy))) throw notFound("Berkas");
    const bytes = await readFile(join(context.config.files.dir, row.storageKey)).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "ENOENT") throw notFound("Berkas");
      throw error;
    });
    return reply
      .header("content-type", row.mimeType)
      .header("content-disposition", disposition(row.originalName))
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=86400")
      .send(bytes);
  });
}

