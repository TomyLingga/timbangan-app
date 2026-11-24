// The phone's push token and the inbox. Open to every signed-in account (staff and partner, with or without
// permissions); each route only reads or changes the caller's own rows.
import { and, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { DEVICE_PLATFORMS, exceptions, notificationDeliveries, notifications, userDevices } from "../db/schema.js";
import { notFound } from "../errors.js";
import { idNumber, idParams, limitParam } from "../http.js";

const deviceBody = z.object({
  platform: z.enum(DEVICE_PLATFORMS, "Platform harus ANDROID, IOS, atau WEB."),
  pushToken: z.string("Token perangkat wajib diisi.").trim().min(1, "Token perangkat wajib diisi.").max(4096, "Token perangkat terlalu panjang."),
  appVersion: z.string().trim().max(50, "Versi aplikasi terlalu panjang.").nullable().optional(),
});
const tokenParams = z.object({ pushToken: z.string().min(1).max(4096) });
const listQuery = z.object({
  unread: z.enum(["true", "false", "1", "0"], "unread harus true atau false.").optional(),
  limit: limitParam,
  // the id of the last item of the previous page; the next page holds older notifications
  before: idNumber.optional(),
});

const deviceView = (row: typeof userDevices.$inferSelect) => ({
  id: row.id,
  platform: row.platform,
  appVersion: row.appVersion,
  isActive: row.isActive,
  lastSeenAt: row.lastSeenAt,
});

/** The caller's inbox entries, newest first. */
async function inbox(orm: Orm, userId: number, where: { unread?: boolean; before?: number; notificationId?: number }, limit: number) {
  const rows = await orm
    .select({
      id: notifications.id,
      type: notifications.type,
      severity: notifications.severity,
      title: notifications.title,
      body: notifications.body,
      data: notifications.data,
      exceptionId: notifications.exceptionId,
      exceptionStatus: exceptions.status,
      tripId: notifications.tripId,
      createdAt: notifications.createdAt,
      readAt: notificationDeliveries.readAt,
    })
    .from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .leftJoin(exceptions, eq(exceptions.id, notifications.exceptionId))
    .where(
      and(
        eq(notificationDeliveries.userId, userId),
        eq(notificationDeliveries.channel, "IN_APP"),
        where.unread ? isNull(notificationDeliveries.readAt) : undefined,
        where.before === undefined ? undefined : lt(notifications.id, where.before),
        where.notificationId === undefined ? undefined : eq(notifications.id, where.notificationId),
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(limit);
  return rows;
}

async function unreadCount(orm: Orm, userId: number): Promise<number> {
  const [row] = await orm
    .select({ n: count() })
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.channel, "IN_APP"), isNull(notificationDeliveries.readAt)));
  return Number(row?.n ?? 0);
}

export function registerNotificationRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const signedIn = { preHandler: [guards.authenticate] };
  const orm = context.database.db;

  // Records the token of this phone for the caller. A token known already moves to the caller (the phone changed
  // hands or another account signed in on it); pushes still waiting for the previous account are dropped.
  app.post("/api/devices", signedIn, async (request) => {
    const body = deviceBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const device = await orm.transaction(async (tx) => {
      const [previous] = await tx.select().from(userDevices).where(eq(userDevices.pushToken, body.pushToken)).for("update");
      if (previous && previous.userId !== account.id) {
        await tx
          .update(notificationDeliveries)
          .set({ error: "DEVICE_MOVED" })
          .where(and(eq(notificationDeliveries.deviceId, previous.id), isNull(notificationDeliveries.sentAt), isNull(notificationDeliveries.error)));
      }
      const [row] = await tx
        .insert(userDevices)
        .values({ userId: account.id, platform: body.platform, pushToken: body.pushToken, appVersion: body.appVersion ?? null, isActive: true, lastSeenAt: now })
        .onConflictDoUpdate({
          target: userDevices.pushToken,
          set: { userId: account.id, platform: body.platform, appVersion: body.appVersion ?? null, isActive: true, lastSeenAt: now },
        })
        .returning();
      if (!row) throw new Error("The device was not saved.");
      return row;
    });
    return { device: deviceView(device) };
  });

  // At sign-out: the phone gets no more pushes for the caller. Another account's token answers 404.
  app.delete("/api/devices/:pushToken", signedIn, async (request, reply) => {
    const { pushToken } = tokenParams.parse(request.params);
    const account = accountOf(request);
    const [row] = await orm
      .update(userDevices)
      .set({ isActive: false, lastSeenAt: context.now() })
      .where(and(eq(userDevices.pushToken, pushToken), eq(userDevices.userId, account.id)))
      .returning({ id: userDevices.id });
    if (!row) throw notFound("Perangkat");
    return reply.code(204).send();
  });

  app.get("/api/notifications", signedIn, async (request) => {
    const query = listQuery.parse(request.query);
    const account = accountOf(request);
    const unread = query.unread === "true" || query.unread === "1";
    return {
      items: await inbox(orm, account.id, { unread, ...(query.before === undefined ? {} : { before: query.before }) }, query.limit),
      unreadCount: await unreadCount(orm, account.id),
    };
  });

  app.post("/api/notifications/:id/read", signedIn, async (request) => {
    const { id } = idParams.parse(request.params);
    const account = accountOf(request);
    // a second call keeps the first time
    const [row] = await orm
      .update(notificationDeliveries)
      .set({ readAt: sql`coalesce(${notificationDeliveries.readAt}, ${context.now().toISOString()}::timestamptz)` })
      .where(and(eq(notificationDeliveries.notificationId, id), eq(notificationDeliveries.userId, account.id), eq(notificationDeliveries.channel, "IN_APP")))
      .returning({ id: notificationDeliveries.id });
    if (!row) throw notFound("Pemberitahuan");
    const [item] = await inbox(orm, account.id, { notificationId: id }, 1);
    return { notification: item, unreadCount: await unreadCount(orm, account.id) };
  });

  app.post("/api/notifications/read-all", signedIn, async (request) => {
    const account = accountOf(request);
    const rows = await orm
      .update(notificationDeliveries)
      .set({ readAt: context.now() })
      .where(and(eq(notificationDeliveries.userId, account.id), eq(notificationDeliveries.channel, "IN_APP"), isNull(notificationDeliveries.readAt)))
      .returning({ id: notificationDeliveries.id });
    return { updated: rows.length, unreadCount: 0 };
  });
}
