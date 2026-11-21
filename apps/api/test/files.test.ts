// Photos sent by the phones: one image per request, typed by its first bytes, kept under a random key.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { multipart, PNG_BYTES } from "./helpers/field.js";
import { bearer, seedPartner, seedPartnerUser, seedStaff } from "./helpers/users.js";

const JPEG_BYTES = Buffer.concat([Buffer.from("ffd8ffe000104a464946000101", "hex"), Buffer.alloc(64, 7), Buffer.from("ffd9", "hex")]);
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32, 1)]);

async function setup() {
  const ctx = await testApp();
  await seedStaff(ctx.database, "lapangan", { qc: "CREATE" });
  await seedPartnerUser(ctx.database, "mitra", await seedPartner(ctx.database, "PT Mitra Contoh", { supplier: true }));
  const staff = await bearer(ctx.app, "lapangan");
  const upload = async (file: Parameters<typeof multipart>[0], headers: { authorization: string } = staff) => {
    const body = multipart(file);
    return ctx.app.inject({ method: "POST", url: "/api/files", headers: { ...headers, ...body.headers }, payload: body.payload });
  };
  return { ...ctx, staff, upload };
}

/** Every file below the storage root, as paths relative to it. */
async function stored(root: string): Promise<string[]> {
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

describe("POST /api/files", () => {
  it("stores a PNG under a random key with its sha256, never the client's name, and answers its id", async () => {
    const { upload, database, config, app, staff } = await setup();
    const response = await upload({ name: "../../etc/BK1234AA.png", type: "application/octet-stream", bytes: PNG_BYTES });
    expect(response.statusCode, response.body).toBe(201);
    const { id } = response.json();
    const [row] = await database.query<{ storage_key: string; mime_type: string; size_bytes: number; sha256: string; kind: string; uploaded_by: number }>(
      "select storage_key, mime_type, size_bytes::int as size_bytes, sha256, kind, uploaded_by::int as uploaded_by from files where id = $1",
      [id],
    );
    expect(row).toMatchObject({ mime_type: "image/png", size_bytes: PNG_BYTES.length, sha256: createHash("sha256").update(PNG_BYTES).digest("hex"), kind: "PHOTO" });
    expect(row?.storage_key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/);
    expect(row?.storage_key).not.toContain("BK1234AA");
    expect(await stored(config.files.dir)).toEqual([row?.storage_key]);
    expect(await readFile(join(config.files.dir, String(row?.storage_key)))).toEqual(PNG_BYTES);

    const back = await app.inject({ method: "GET", url: `/api/files/${id}`, headers: staff });
    expect(back.statusCode).toBe(200);
    expect(back.headers["content-type"]).toBe("image/png");
    expect(back.headers["x-content-type-options"]).toBe("nosniff");
    expect(back.rawPayload).toEqual(PNG_BYTES);
  });

  it("types JPEG and WebP by their first bytes, whatever the name and header say", async () => {
    const { upload, database } = await setup();
    const jpeg = await upload({ name: "foto.png", type: "image/png", bytes: JPEG_BYTES });
    const webp = await upload({ name: "foto.jpg", type: "image/jpeg", bytes: WEBP_BYTES });
    expect([jpeg.statusCode, webp.statusCode]).toEqual([201, 201]);
    const rows = await database.query<{ mime_type: string; storage_key: string }>("select mime_type, storage_key from files order by id");
    expect(rows.map((row) => row.mime_type)).toEqual(["image/jpeg", "image/webp"]);
    expect(rows.map((row) => row.storage_key.split(".").at(-1))).toEqual(["jpg", "webp"]);
  });

  it("refuses what is not one of the three images, a file over 5 MB, a request without a file, and keeps nothing", async () => {
    const { upload, database, config, app, staff } = await setup();
    const text = await upload({ name: "foto.png", type: "image/png", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
    expect(text.statusCode).toBe(400);
    expect(text.json().error).toMatchObject({ code: "VALIDATION", fields: [{ field: "file", message: "Berkas harus gambar JPEG, PNG, atau WebP." }] });
    const big = await upload({ bytes: Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toEqual({ code: "FILE_TOO_LARGE", message: "Berkas paling besar 5 MB." });
    const exactly = await upload({ bytes: Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024 - PNG_BYTES.length)]) });
    expect(exactly.statusCode).toBe(201);
    const json = await app.inject({ method: "POST", url: "/api/files", headers: staff, payload: { file: "x" } });
    expect(json.statusCode).toBe(400);
    expect(json.json().error.fields).toEqual([{ field: "file", message: "Kirim satu gambar sebagai multipart/form-data." }]);
    expect(await database.query("select count(*)::int as n from files")).toEqual([{ n: 1 }]);
    expect((await stored(config.files.dir)).length).toBe(1);
  });

  it("is for staff accounts only, both ways", async () => {
    const { upload, app, staff } = await setup();
    const partner = await bearer(app, "mitra");
    expect((await upload({ bytes: PNG_BYTES }, partner)).statusCode).toBe(403);
    expect((await upload({ bytes: PNG_BYTES }, { authorization: "Bearer nope" })).statusCode).toBe(401);
    const id = (await upload({ bytes: PNG_BYTES })).json().id;
    expect((await app.inject({ method: "GET", url: `/api/files/${id}`, headers: partner })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/files/999999", headers: staff })).statusCode).toBe(404);
  });
});
