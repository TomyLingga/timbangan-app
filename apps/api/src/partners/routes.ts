import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { partners } from "../db/schema.js";
import { AppError, invalid } from "../errors.js";
import { likeText, limitParam, searchParam } from "../http.js";

const listQuery = z.object({
  role: z.enum(["supplier", "customer", "transporter"], "Role harus supplier, customer, atau transporter.").optional(),
  q: searchParam,
  limit: limitParam,
});

const NAME_MESSAGE = "Nama partner wajib diisi, 2 sampai 200 huruf.";
const flag = (name: string) => z.boolean(`${name} harus true atau false.`).default(false);
/** Name and address of a partner kept only here; also the new mill of POST /api/admin/users. */
export const localPartnerFields = {
  name: z.string(NAME_MESSAGE).trim().min(2, NAME_MESSAGE).max(200, NAME_MESSAGE),
  address: z.string("Alamat harus berupa teks.").trim().max(500, "Alamat terlalu panjang.").nullable().optional(),
};
const createBody = z.object({
  ...localPartnerFields,
  isSupplier: flag("isSupplier"),
  isTransporter: flag("isTransporter"),
  isCustomer: flag("isCustomer"),
});

const ROLE_COLUMN = { supplier: partners.isSupplier, customer: partners.isCustomer, transporter: partners.isTransporter };

const columns = {
  id: partners.id,
  name: partners.name,
  code: partners.code,
  address: partners.address,
  isSupplier: partners.isSupplier,
  isCustomer: partners.isCustomer,
  isTransporter: partners.isTransporter,
  // a partner added in this application (a mill selling through a trader is not in the ERP) has no ERP reference
  erpSystem: partners.erpSystem,
};

/** One partner at a time is added, so that the name check below sees the one added just before. */
const lockLocalPartners = (orm: Orm) => orm.execute(sql`select pg_advisory_xact_lock(hashtext('partners_local'))`);

export interface LocalPartner {
  name: string;
  address?: string | null;
  isSupplier: boolean;
  isTransporter: boolean;
  isCustomer: boolean;
}

/**
 * Adds a partner that is not in the ERP, inside the caller's transaction, and audits it. A name equal to one already
 * there (ignoring case and the spaces around it) is refused with 409 PARTNER_EXISTS and the id of that partner.
 */
export async function insertLocalPartner(tx: Orm, request: FastifyRequest, now: Date, input: LocalPartner) {
  await lockLocalPartners(tx);
  const [same] = await tx
    .select({ id: partners.id, name: partners.name })
    .from(partners)
    .where(sql`lower(btrim(${partners.name})) = lower(${input.name})`)
    .orderBy(asc(partners.id))
    .limit(1);
  if (same) throw new AppError(409, "PARTNER_EXISTS", `Partner dengan nama ${same.name} sudah ada.`, undefined, { partnerId: same.id });
  const [created] = await tx
    .insert(partners)
    .values({ name: input.name, address: input.address || null, isSupplier: input.isSupplier, isTransporter: input.isTransporter, isCustomer: input.isCustomer, createdAt: now, updatedAt: now })
    .returning(columns);
  if (!created) throw new Error("The partner was not created.");
  await writeAudit(tx, request, now, {
    action: "PARTNER_CREATED",
    entityType: "partner",
    entityId: created.id,
    before: null,
    after: { name: created.name, address: created.address, isSupplier: created.isSupplier, isTransporter: created.isTransporter, isCustomer: created.isCustomer },
  });
  return created;
}

/**
 * Lookup of active partners for the staff screens (choosing a supplier, a customer, a transporter), and the partners
 * kept only here. Partners come from the ERP (contract partners) and from the driver registry (transporters); a mill
 * (PKS) that sells through a trader is in neither (owner, 26 November 2026), so staff add it here. The Odoo sync
 * matches partners by their ERP reference and the registry sync by its own code prefix; a partner added here has
 * neither, so no sync overwrites or removes it.
 */
export function registerPartnerRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  // the staff who send shipment requests to the mills are the ones who find a mill missing
  const creators = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("shipment_requests", "CREATE")] };

  app.get("/api/partners", { preHandler: [guards.authenticate, guards.requireInternal] }, async (request) => {
    const query = listQuery.parse(request.query);
    const pattern = query.q ? likeText(query.q) : null;
    const where = and(
      eq(partners.isActive, true),
      query.role ? eq(ROLE_COLUMN[query.role], true) : undefined,
      pattern ? or(ilike(partners.name, pattern), ilike(partners.code, pattern)) : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(partners).where(where);
    const items = await orm
      .select(columns)
      .from(partners)
      .where(where)
      .orderBy(asc(sql`lower(${partners.name})`), asc(partners.id))
      .limit(query.limit);
    return { items, total: counted?.total ?? 0 };
  });

  /**
   * Adds a partner that is not in the ERP. A name equal to one already there (ignoring case and the spaces around
   * it) is refused with 409 PARTNER_EXISTS and the id of that partner, so a script loading names can carry on.
   */
  app.post("/api/partners", creators, async (request, reply) => {
    const body = createBody.parse(request.body);
    if (!body.isSupplier && !body.isTransporter && !body.isCustomer) throw invalid("isSupplier", "Pilih minimal satu jenis partner: supplier, transporter, atau customer.");
    const now = context.now();
    const partner = await orm.transaction((tx) => insertLocalPartner(tx, request, now, body));
    request.log.info({ partnerId: partner.id, by: accountOf(request).id }, "local partner added");
    return reply.code(201).send({ partner });
  });
}
