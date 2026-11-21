// Stations: the fixed points of the plant (weighbridges first). A weighbridge PC signs its requests with a
// machine key made here; the key is shown once and only its hash is kept.
import { and, asc, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { STATION_KINDS, stations, zones } from "../db/schema.js";
import { duplicate, invalid, notFound } from "../errors.js";
import { idParams } from "../http.js";
import { defaultSite } from "../settings.js";
import { generateStationKey } from "./keys.js";
import { PIN_PATTERN, setStationPin } from "./pin.js";

/** What a weighbridge station is set up with. */
export const weighbridgeConfig = z.object({
  directions: z
    .array(z.enum(["IN", "OUT"], "Arah harus IN atau OUT."), "Arah wajib diisi.")
    .min(1, "Pilih minimal satu arah.")
    .transform((list) => [...new Set(list)]),
  // the plate-reader camera (its number in the reader service) for the first and the second weighing
  cameraWeigh1: z.number("Nomor kamera harus angka.").int("Nomor kamera harus angka bulat.").min(1).max(99).nullable().default(null),
  cameraWeigh2: z.number("Nomor kamera harus angka.").int("Nomor kamera harus angka bulat.").min(1).max(99).nullable().default(null),
  // how many weigh requests with a wrong plate are answered "try again" before the plate goes to a supervisor
  plateAttempts: z.number("Jumlah percobaan plat harus angka.").int().min(1, "Jumlah percobaan plat 1 sampai 10.").max(10, "Jumlah percobaan plat 1 sampai 10.").default(3),
});
export type WeighbridgeConfig = z.infer<typeof weighbridgeConfig>;

/** The config of a weighbridge as stored; a row written before the defaults existed still reads. */
export function readWeighbridgeConfig(config: Record<string, unknown>): WeighbridgeConfig {
  const parsed = weighbridgeConfig.safeParse(config);
  return parsed.success ? parsed.data : { directions: ["IN", "OUT"], cameraWeigh1: null, cameraWeigh2: null, plateAttempts: 3 };
}

const pinField = z.string("PIN harus berupa teks angka.").regex(PIN_PATTERN, "PIN harus 4 sampai 8 angka.");
const fields = {
  code: z.string("Kode wajib diisi.").trim().toUpperCase().min(1, "Kode wajib diisi.").max(30, "Kode terlalu panjang."),
  name: z.string("Nama wajib diisi.").trim().min(1, "Nama wajib diisi.").max(100, "Nama terlalu panjang."),
  kind: z.enum(STATION_KINDS, `Jenis harus salah satu dari ${STATION_KINDS.join(", ")}.`),
  zoneId: z.number("Zona harus angka.").int().positive().nullable().optional(),
  config: z.record(z.string(), z.unknown(), "Config harus berupa objek.").optional(),
  isActive: z.boolean("isActive harus true atau false.").optional(),
};
const createBody = z.object({ ...fields, pin: pinField.optional() });
const patchBody = z.object({
  code: fields.code.optional(),
  name: fields.name.optional(),
  kind: fields.kind.optional(),
  zoneId: fields.zoneId,
  config: fields.config,
  isActive: fields.isActive,
  pin: pinField.nullable().optional(),
});

type StationRow = typeof stations.$inferSelect;

const view = (row: StationRow) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: row.kind,
  zoneId: row.zoneId,
  config: row.config,
  isActive: row.isActive,
  hasKey: row.apiKeyHash !== null,
  keyCreatedAt: row.keyCreatedAt,
  hasPin: row.pinHash !== null,
});

/** The config to store for this kind: a weighbridge's is checked and completed; others are kept as sent. */
function configFor(kind: string, config: Record<string, unknown> | undefined): Record<string, unknown> {
  if (kind !== "WEIGHBRIDGE") return config ?? {};
  const parsed = weighbridgeConfig.safeParse(config ?? {});
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

/** Validation issues of the body and of the weighbridge config together, so the form shows them at once. */
function parseWithConfig<T extends { kind?: string; config?: Record<string, unknown> }>(schema: z.ZodType<T>, body: unknown, kindNow?: string): T {
  const parsed = schema.safeParse(body ?? {});
  const issues = parsed.success ? [] : [...parsed.error.issues];
  const raw = (body ?? {}) as { kind?: unknown; config?: unknown };
  const kind = parsed.success ? (parsed.data.kind ?? kindNow) : typeof raw.kind === "string" ? raw.kind : kindNow;
  if (kind === "WEIGHBRIDGE" && raw.config !== undefined && raw.config !== null && typeof raw.config === "object") {
    const config = weighbridgeConfig.safeParse(raw.config);
    if (!config.success) issues.push(...config.error.issues.map((issue) => ({ ...issue, path: ["config", ...issue.path] })));
  }
  if (issues.length) throw new z.ZodError(issues);
  return (parsed as { data: T }).data;
}

async function checkZone(orm: Orm, zoneId: number | null | undefined): Promise<void> {
  if (zoneId === null || zoneId === undefined) return;
  const [zone] = await orm.select({ id: zones.id }).from(zones).where(eq(zones.id, zoneId));
  if (!zone) throw invalid("zoneId", "Zona tidak ditemukan.");
}

export function registerStationRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const editors = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("weighbridge", "EDIT")] };

  const codeTaken = async (siteId: number, code: string, exceptId: number | null) =>
    (await orm.select({ id: stations.id }).from(stations).where(and(eq(stations.siteId, siteId), eq(stations.code, code), exceptId === null ? undefined : ne(stations.id, exceptId)))).length > 0;

  app.get("/api/stations", editors, async () => {
    const rows = await orm.select().from(stations).orderBy(asc(stations.code));
    return { items: rows.map(view) };
  });

  app.post("/api/stations", editors, async (request, reply) => {
    const body = parseWithConfig(createBody, request.body);
    const now = context.now();
    const site = await defaultSite(orm);
    await checkZone(orm, body.zoneId);
    if (await codeTaken(site.id, body.code, null)) throw duplicate("Kode stasiun sudah dipakai.");
    const station = await orm.transaction(async (tx) => {
      const [row] = await tx
        .insert(stations)
        .values({ siteId: site.id, code: body.code, name: body.name, kind: body.kind, zoneId: body.zoneId ?? null, config: configFor(body.kind, body.config), isActive: body.isActive ?? true })
        .returning();
      if (!row) throw new Error("Station was not created.");
      if (body.pin) await setStationPin(tx, row.id, body.pin);
      const [stored] = await tx.select().from(stations).where(eq(stations.id, row.id));
      if (!stored) throw new Error("Station was not created.");
      const shown = view(stored);
      await writeAudit(tx, request, now, { action: "STATION_CREATED", entityType: "station", entityId: row.id, before: null, after: shown });
      return shown;
    });
    return reply.code(201).send({ station });
  });

  app.patch("/api/stations/:id", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const [current] = await orm.select().from(stations).where(eq(stations.id, id));
    if (!current) throw notFound("Stasiun");
    const body = parseWithConfig(patchBody, request.body, current.kind);
    const now = context.now();
    await checkZone(orm, body.zoneId);
    if (body.code && (await codeTaken(current.siteId, body.code, id))) throw duplicate("Kode stasiun sudah dipakai.");
    const kind = body.kind ?? current.kind;
    const station = await orm.transaction(async (tx) => {
      await tx
        .update(stations)
        .set({
          ...(body.code ? { code: body.code } : {}),
          ...(body.name ? { name: body.name } : {}),
          kind,
          ...(body.zoneId !== undefined ? { zoneId: body.zoneId } : {}),
          ...(body.config !== undefined || body.kind !== undefined ? { config: configFor(kind, body.config ?? current.config) } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        })
        .where(eq(stations.id, id));
      if (body.pin !== undefined) await setStationPin(tx, id, body.pin);
      const [stored] = await tx.select().from(stations).where(eq(stations.id, id));
      if (!stored) throw notFound("Stasiun");
      const shown = view(stored);
      await writeAudit(tx, request, now, { action: "STATION_UPDATED", entityType: "station", entityId: id, before: view(current), after: shown });
      return shown;
    });
    return { station };
  });

  app.post("/api/stations/:id/key", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const now = context.now();
    const [current] = await orm.select().from(stations).where(eq(stations.id, id));
    if (!current) throw notFound("Stasiun");
    const { key, hash } = generateStationKey(id);
    const station = await orm.transaction(async (tx) => {
      const [stored] = await tx.update(stations).set({ apiKeyHash: hash, keyCreatedAt: now }).where(eq(stations.id, id)).returning();
      if (!stored) throw notFound("Stasiun");
      await writeAudit(tx, request, now, { action: "STATION_KEY_CREATED", entityType: "station", entityId: id, before: { hadKey: current.apiKeyHash !== null }, after: { keyCreatedAt: now } });
      return view(stored);
    });
    return { station, key };
  });
}
