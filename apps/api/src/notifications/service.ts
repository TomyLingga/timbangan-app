// Making notifications: one row per event, an IN_APP delivery per recipient and a PUSH delivery per active device of
// each recipient. The sender (sender.ts) sends the PUSH rows.
//
// Exception notifications are made from the state of the exceptions table, by the loop in sender.ts, not by the code
// that raises or closes a request: a request is raised by the weighbridge and the QC form, closed by a decision, a
// cancel, or the lazy expiry, and reading the table catches all of them. One "raised" and one "closed" row per
// exception (unique index of 0014), so two processes running the loop do not notify twice.
import { and, asc, eq, gt, inArray, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Orm } from "../db/client.js";
import { type ExceptionType, exceptions, modules, notificationDeliveries, notifications, registrations, trips, userDevices, userPermissions, users } from "../db/schema.js";
import { findRule } from "../weighing/rules.js";

export const EXCEPTION_RAISED = "EXCEPTION_RAISED";
export const EXCEPTION_CLOSED = "EXCEPTION_CLOSED";
export const DO_SENT = "DO_SENT";
export const SHIPMENT_REQUEST_SENT = "SHIPMENT_REQUEST_SENT";

/** Pushes of one request at most, besides the first. */
export const MAX_REMINDERS = 10;
/** The reminder interval when the rule gives none. */
export const DEFAULT_ESCALATE_AFTER_S = 60;
/** A request closed this long after it was raised gets no "closed" message any more (it bounds the scan). */
const CLOSE_LOOKBACK_MS = 30 * 86_400_000;
/** Requests handled per round of each kind; the rest waits for the next round. */
const BATCH = 100;

/** The title of the push and of the inbox entry: the kind of request only. */
export const EXCEPTION_TITLES: Record<ExceptionType, string> = {
  PLATE: "Plat nomor menunggu keputusan",
  GROSS_IN: "Selisih bruto menunggu keputusan",
  TARE_OUT: "Selisih tarra menunggu keputusan",
  NET_IN: "Selisih netto menunggu keputusan",
  NET_OUT: "Netto muat menunggu keputusan",
  QC_HOLD: "Hasil QC menunggu keputusan",
};
export const CLOSED_TITLE = "Permintaan keputusan selesai";
export const DO_SENT_TITLE = "Delivery order baru";
export const SHIPMENT_REQUEST_SENT_TITLE = "Permintaan pengiriman baru";

/** The body: the trip number only. */
const tripText = (tripNo: string | null, tripId: number) => tripNo ?? `Trip #${tripId}`;

interface NewNotification {
  siteId: number | null;
  type: string;
  severity: "INFO" | "WARNING" | "ALARM";
  title: string;
  body: string;
  data: Record<string, string | number>;
  exceptionId?: number;
  tripId?: number;
}

/** PUSH rows for the active devices of these users. */
async function addPushes(orm: Orm, notificationId: number, userIds: number[], now: Date): Promise<number> {
  if (userIds.length === 0) return 0;
  const devices = await orm
    .select({ id: userDevices.id, userId: userDevices.userId })
    .from(userDevices)
    .where(and(inArray(userDevices.userId, userIds), eq(userDevices.isActive, true)))
    .orderBy(asc(userDevices.id));
  if (devices.length === 0) return 0;
  await orm
    .insert(notificationDeliveries)
    .values(devices.map((device) => ({ notificationId, userId: device.userId, deviceId: device.id, channel: "PUSH" as const, createdAt: now })));
  return devices.length;
}

/**
 * Inserts the notification with its deliveries. Answers its id, or null when an exception notification of this
 * type exists already.
 */
async function createNotification(orm: Orm, input: NewNotification, recipients: number[], channels: { inApp: boolean }, now: Date): Promise<number | null> {
  return orm.transaction(async (tx) => {
    const [row] = await tx
      .insert(notifications)
      .values({ ...input, exceptionId: input.exceptionId ?? null, tripId: input.tripId ?? null, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (!row) return null;
    const userIds = [...new Set(recipients)];
    if (channels.inApp && userIds.length > 0) {
      await tx.insert(notificationDeliveries).values(userIds.map((userId) => ({ notificationId: row.id, userId, channel: "IN_APP" as const, createdAt: now })));
    }
    await addPushes(tx, row.id, userIds, now);
    return row.id;
  });
}

/** Active staff accounts holding the module at EDIT, on every site or on this one. */
async function deciders(orm: Orm, moduleCode: string, siteId: number): Promise<number[]> {
  const rows = await orm
    .select({ id: users.id })
    .from(users)
    .innerJoin(userPermissions, and(eq(userPermissions.userId, users.id), eq(userPermissions.moduleCode, moduleCode), eq(userPermissions.level, "EDIT")))
    .innerJoin(modules, and(eq(modules.code, userPermissions.moduleCode), eq(modules.isActive, true)))
    .where(and(eq(users.isActive, true), eq(users.kind, "INTERNAL"), or(isNull(users.siteId), eq(users.siteId, siteId))))
    .orderBy(asc(users.id));
  return rows.map((row) => row.id);
}

/** The accounts that got the inbox entry of a notification. */
async function inboxRecipients(orm: Orm, notificationId: number): Promise<number[]> {
  const rows = await orm
    .selectDistinct({ userId: notificationDeliveries.userId })
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.notificationId, notificationId), eq(notificationDeliveries.channel, "IN_APP")));
  return rows.map((row) => row.userId);
}

/** A DO sent to its transporter: the active accounts of that company get one INFO notification. */
export async function notifyDeliveryOrderSent(orm: Orm, order: { id: number; doNo: string; siteId: number; transporterId: number }, now: Date): Promise<number | null> {
  const accounts = await orm
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.kind, "PARTNER"), eq(users.partnerId, order.transporterId), eq(users.isActive, true)))
    .orderBy(asc(users.id));
  return createNotification(
    orm,
    { siteId: order.siteId, type: DO_SENT, severity: "INFO", title: DO_SENT_TITLE, body: order.doNo, data: { type: DO_SENT, deliveryOrderId: order.id } },
    accounts.map((account) => account.id),
    { inApp: true },
    now,
  );
}

/** A shipment request sent to its supplier (the mill): the active accounts of that company get one INFO notification. */
export async function notifyShipmentRequestSent(
  orm: Orm,
  request: { id: number; contractNo: string; siteId: number; supplierId: number },
  now: Date,
): Promise<number | null> {
  const accounts = await orm
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.kind, "PARTNER"), eq(users.partnerId, request.supplierId), eq(users.isActive, true)))
    .orderBy(asc(users.id));
  return createNotification(
    orm,
    {
      siteId: request.siteId,
      type: SHIPMENT_REQUEST_SENT,
      severity: "INFO",
      title: SHIPMENT_REQUEST_SENT_TITLE,
      body: request.contractNo,
      data: { type: SHIPMENT_REQUEST_SENT, shipmentRequestId: request.id },
    },
    accounts.map((account) => account.id),
    { inApp: true },
    now,
  );
}

const raisedNotification = alias(notifications, "raised_notification");
const closedNotification = alias(notifications, "closed_notification");

export interface ExceptionRound {
  raised: number;
  reminded: number;
  closed: number;
}

/**
 * One pass over the exceptions: a "raised" notification for each waiting request that has none, a "closed" one for
 * each request with a "raised" one that is no longer waiting, and, when `reminders` is on, the push again to the
 * same accounts once the rule's escalate_after_s passed since the last one (at most MAX_REMINDERS times).
 */
export async function processExceptions(orm: Orm, now: Date, options: { reminders: boolean }): Promise<ExceptionRound> {
  const round: ExceptionRound = { raised: 0, reminded: 0, closed: 0 };

  // closed first: their pushes still pending are dropped before anything else is sent
  const closing = await orm
    .select({ raisedId: raisedNotification.id, exceptionId: exceptions.id, siteId: exceptions.siteId, tripId: exceptions.tripId, tripNo: trips.tripNo })
    .from(raisedNotification)
    .innerJoin(exceptions, eq(exceptions.id, raisedNotification.exceptionId))
    .innerJoin(trips, eq(trips.id, exceptions.tripId))
    .where(
      and(
        eq(raisedNotification.type, EXCEPTION_RAISED),
        ne(exceptions.status, "PENDING"),
        gt(raisedNotification.createdAt, new Date(now.getTime() - CLOSE_LOOKBACK_MS)),
        notExists(
          orm
            .select({ one: sql`1` })
            .from(closedNotification)
            .where(and(eq(closedNotification.exceptionId, exceptions.id), eq(closedNotification.type, EXCEPTION_CLOSED))),
        ),
      ),
    )
    .orderBy(asc(exceptions.id))
    .limit(BATCH);
  for (const row of closing) {
    await orm
      .update(notificationDeliveries)
      .set({ error: "EXCEPTION_CLOSED" })
      .where(and(eq(notificationDeliveries.notificationId, row.raisedId), eq(notificationDeliveries.channel, "PUSH"), isNull(notificationDeliveries.sentAt), isNull(notificationDeliveries.error)));
    // a data-only push that lets the phone take the alarm away; no inbox entry
    const id = await createNotification(
      orm,
      { siteId: row.siteId, type: EXCEPTION_CLOSED, severity: "INFO", title: CLOSED_TITLE, body: tripText(row.tripNo, row.tripId), data: { type: EXCEPTION_CLOSED, exceptionId: row.exceptionId, tripId: row.tripId }, exceptionId: row.exceptionId, tripId: row.tripId },
      await inboxRecipients(orm, row.raisedId),
      { inApp: false },
      now,
    );
    if (id !== null) round.closed++;
  }

  const waiting = await orm
    .select({ id: exceptions.id, siteId: exceptions.siteId, tripId: exceptions.tripId, type: exceptions.type, approverModule: exceptions.approverModule, tripNo: trips.tripNo })
    .from(exceptions)
    .innerJoin(trips, eq(trips.id, exceptions.tripId))
    .where(
      and(
        eq(exceptions.status, "PENDING"),
        notExists(
          orm
            .select({ one: sql`1` })
            .from(raisedNotification)
            .where(and(eq(raisedNotification.exceptionId, exceptions.id), eq(raisedNotification.type, EXCEPTION_RAISED))),
        ),
      ),
    )
    .orderBy(asc(exceptions.id))
    .limit(BATCH);
  for (const row of waiting) {
    const id = await createNotification(
      orm,
      { siteId: row.siteId, type: EXCEPTION_RAISED, severity: "ALARM", title: EXCEPTION_TITLES[row.type], body: tripText(row.tripNo, row.tripId), data: { type: EXCEPTION_RAISED, exceptionId: row.id, tripId: row.tripId }, exceptionId: row.id, tripId: row.tripId },
      await deciders(orm, row.approverModule, row.siteId),
      { inApp: true },
      now,
    );
    if (id !== null) round.raised++;
  }

  if (!options.reminders) return round;
  const due = await orm
    .select({
      id: exceptions.id,
      siteId: exceptions.siteId,
      type: exceptions.type,
      reminderCount: exceptions.reminderCount,
      lastRemindedAt: exceptions.lastRemindedAt,
      flowCode: registrations.flowCode,
      raisedId: raisedNotification.id,
      raisedAt: raisedNotification.createdAt,
    })
    .from(exceptions)
    .innerJoin(raisedNotification, and(eq(raisedNotification.exceptionId, exceptions.id), eq(raisedNotification.type, EXCEPTION_RAISED)))
    .innerJoin(trips, eq(trips.id, exceptions.tripId))
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .where(and(eq(exceptions.status, "PENDING"), lt(exceptions.reminderCount, MAX_REMINDERS)))
    .orderBy(asc(exceptions.id))
    .limit(BATCH);
  for (const row of due) {
    const rule = await findRule(orm, row.siteId, row.type, row.flowCode, now);
    const everyMs = (rule?.escalateAfterS ?? DEFAULT_ESCALATE_AFTER_S) * 1000;
    const last = row.lastRemindedAt ?? row.raisedAt;
    if (now.getTime() - last.getTime() < everyMs) continue;
    const reminded = await orm.transaction(async (tx) => {
      // compared with the count read above, so a second process does not remind twice
      const [claimed] = await tx
        .update(exceptions)
        .set({ reminderCount: row.reminderCount + 1, lastRemindedAt: now })
        .where(and(eq(exceptions.id, row.id), eq(exceptions.status, "PENDING"), eq(exceptions.reminderCount, row.reminderCount)))
        .returning({ id: exceptions.id });
      if (!claimed) return false;
      await addPushes(tx, row.raisedId, await inboxRecipients(tx, row.raisedId), now);
      return true;
    });
    if (reminded) round.reminded++;
  }
  return round;
}
