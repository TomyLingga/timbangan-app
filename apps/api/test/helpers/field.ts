// Made-up accounts, tanks, seals and photos for the phase 5 field forms, on top of the phase 4 test application.
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db/client.js";
import { weighingApp } from "./weighing.js";
import { bearer, seedStaff } from "./users.js";

/** A tiny valid PNG (1 x 1 pixel). */
export const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5dd3e3c0000000049454e44ae426082",
  "hex",
);

/** A multipart body with one file part, as a phone sends it. */
export function multipart(file: { name?: string; field?: string; type?: string; bytes: Buffer }, extra: Record<string, string> = {}) {
  const boundary = `----uji${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(extra)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? "file"}"; filename="${file.name ?? "foto.png"}"\r\nContent-Type: ${file.type ?? "image/png"}\r\n\r\n`,
    ),
  );
  parts.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export async function seedTank(database: Database, seed: { code: string; productId?: number | null; active?: boolean }): Promise<number> {
  const [row] = await database.query<{ id: number }>(
    "insert into storage_tanks (site_id, code, name, product_id, capacity_kg, is_active) select id, $1, $2, $3, 1000000, $4 from sites order by id limit 1 returning id",
    [seed.code, `Tangki ${seed.code}`, seed.productId ?? null, seed.active ?? true],
  );
  return Number(row?.id);
}

/** Stock seals LC-0001 … numbered from `from`; answers their ids in order. */
export async function seedSeals(database: Database, count: number, options: { prefix?: string; from?: number; status?: string; kind?: string } = {}): Promise<number[]> {
  const ids: number[] = [];
  for (let n = 0; n < count; n++) {
    const no = `${options.prefix ?? "LC-"}${String((options.from ?? 1) + n).padStart(4, "0")}`;
    const [row] = await database.query<{ id: number }>(
      "insert into seals (site_id, seal_no, kind, status) select id, $1, $2, $3 from sites order by id limit 1 returning id",
      [no, options.kind ?? "LOCIS", options.status ?? "AVAILABLE"],
    );
    ids.push(Number(row?.id));
  }
  return ids;
}

/**
 * The weighing application plus the field accounts: satpam (security_check CREATE), qcop (qc CREATE), bongkar
 * (unloading CREATE), muat (loading CREATE), segel (sealing CREATE), qclihat (every field module at VIEW),
 * qcspv (qc_approvals EDIT), pabrik (plant_masters EDIT), pabriklihat (plant_masters VIEW); tanks TK-CPO and
 * TK-CPO2 for the crude product, TK-OLN and TK-OLN2 for the refined one; 20 stock seals.
 */
export async function fieldApp() {
  const ctx = await weighingApp();
  const { database, products } = ctx;
  await seedStaff(database, "satpam", { security_check: "CREATE" });
  await seedStaff(database, "qcop", { qc: "CREATE" });
  await seedStaff(database, "bongkar", { unloading: "CREATE" });
  await seedStaff(database, "muat", { loading: "CREATE" });
  await seedStaff(database, "segel", { sealing: "CREATE" });
  await seedStaff(database, "qclihat", { security_check: "VIEW", qc: "VIEW", unloading: "VIEW", loading: "VIEW", sealing: "VIEW" });
  await seedStaff(database, "qcspv", { qc_approvals: "EDIT" });
  await seedStaff(database, "pabrik", { plant_masters: "EDIT" });
  await seedStaff(database, "pabriklihat", { plant_masters: "VIEW" });
  const tanks = {
    cpo: await seedTank(database, { code: "TK-CPO", productId: products.cpo }),
    cpo2: await seedTank(database, { code: "TK-CPO2", productId: products.cpo }),
    olein: await seedTank(database, { code: "TK-OLN", productId: products.olein }),
    olein2: await seedTank(database, { code: "TK-OLN2", productId: products.olein }),
  };
  const seals = await seedSeals(database, 20);

  /** The latest attempt of a step of the trip. */
  const stepId = async (tripId: number, stepCode: string) =>
    Number((await database.query<{ id: number }>("select id from trip_steps where trip_id = $1 and step_code = $2 order by attempt desc limit 1", [tripId, stepCode]))[0]?.id);

  /** POST /api/work/steps/:id/<form> with a fresh clientUuid unless the body has one. */
  const form = (id: number, path: string, body: object, as: string) => ctx.call("POST", `/api/work/steps/${id}/${path}`, as, { clientUuid: randomUUID(), ...body });

  /** A photo uploaded through POST /api/files; answers its id. */
  const photo = async (as = "lapangan") => {
    const upload = multipart({ bytes: PNG_BYTES });
    const response = await ctx.app.inject({ method: "POST", url: "/api/files", headers: { ...(await bearer(ctx.app, as)), ...upload.headers }, payload: upload.payload });
    if (response.statusCode !== 201) throw new Error(`upload failed: ${response.body}`);
    return (response.json() as { id: number }).id;
  };

  const count = async (sql: string, params: unknown[] = []) => Number((await database.query<{ n: number }>(sql, params))[0]?.n);

  return { ...ctx, tanks, seals, stepId, form, photo, count };
}

export type FieldApp = Awaited<ReturnType<typeof fieldApp>>;
