// Photos from the phones: one image per request (JPEG, PNG or WebP, at most 5 MB), typed by its first bytes
// and kept below the storage root under a random key. Forms then refer to the photo by its id.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { files } from "../db/schema.js";
import { AppError, invalid, notFound } from "../errors.js";
import { idParams } from "../http.js";
import { plantDateParts } from "../numbering.js";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = [
  { mime: "image/jpeg", ext: "jpg", matches: (head: Buffer) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { mime: "image/png", ext: "png", matches: (head: Buffer) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: "webp", matches: (head: Buffer) => head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP" },
] as const;

/** The image type of these bytes, from their signature; null for anything else. */
export const imageTypeOf = (bytes: Buffer) => IMAGE_TYPES.find((type) => type.matches(bytes)) ?? null;

const notMultipart = () => invalid("file", "Kirim satu gambar sebagai multipart/form-data.");
const tooLarge = () => new AppError(413, "FILE_TOO_LARGE", "Berkas paling besar 5 MB.");

export async function registerFileRoutes(app: FastifyInstance, context: AppContext, guards: Guards): Promise<void> {
  const orm = context.database.db;
  const staff = { preHandler: [guards.authenticate, guards.requireInternal] };
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10, parts: 11 } });

  app.post("/api/files", staff, async (request, reply) => {
    if (!request.isMultipart()) throw notMultipart();
    let bytes: Buffer;
    let originalName: string | null;
    try {
      const part = await request.file();
      if (!part) throw invalid("file", "Pilih satu gambar.");
      bytes = await part.toBuffer();
      originalName = part.filename ? part.filename.slice(0, 200) : null;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
      throw notMultipart();
    }
    const type = imageTypeOf(bytes);
    if (!type) throw invalid("file", "Berkas harus gambar JPEG, PNG, atau WebP.");

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
          kind: "PHOTO",
          uploadedBy: accountOf(request).id,
          createdAt: now,
        })
        .returning({ id: files.id });
      if (!row) throw new Error("The file was not recorded.");
      return reply.code(201).send({ id: row.id });
    } catch (error) {
      // a file without its row would never be found again
      await unlink(path).catch(() => undefined);
      throw error;
    }
  });

  app.get("/api/files/:id", staff, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const [row] = await orm.select().from(files).where(eq(files.id, id));
    if (!row) throw notFound("Berkas");
    const bytes = await readFile(join(context.config.files.dir, row.storageKey)).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "ENOENT") throw notFound("Berkas");
      throw error;
    });
    return reply
      .header("content-type", row.mimeType)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=86400")
      .send(bytes);
  });
}
