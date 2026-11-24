// The notification loop inside the API process, every few seconds: lazy expiry of silent weighbridge requests, the
// exception notifications (service.ts), and the pending pushes through the provider. Without a provider
// (PUSH_PROVIDER=off) pending pushes are left as they are and no reminders are made. Tests run each part by hand.
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { exceptions, notificationDeliveries, notifications, userDevices } from "../db/schema.js";
import { expireStaleExceptions } from "../exceptions/service.js";
import { DO_SENT, EXCEPTION_CLOSED, EXCEPTION_RAISED, type ExceptionRound, processExceptions } from "./service.js";
import type { PushMessage, PushSender } from "./push.js";

export const LOOP_EVERY_MS = 5_000;
/** A push not sent within this time is dropped: a phone must not ring for an old request. */
export const PUSH_MAX_AGE_MS = 10 * 60_000;
/** FCM keeps an alarm this long for a phone that is offline. */
const ALARM_TTL_S = 600;
/** The Android channel of the requests to decide; the app creates it. */
export const DECISION_CHANNEL = "keputusan";
const BATCH = 50;

export interface SendRound {
  sent: number;
  rejected: number;
  dropped: number;
  /** Why the round stopped early; the rest waits for the next round. */
  retry: string | null;
}

interface PendingRow {
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  notificationId: number;
  exceptionId: number | null;
  token: string;
}

/** The push of a notification: generic title, trip or DO number, ids. */
export function pushMessageOf(row: PendingRow): PushMessage {
  const data: Record<string, string> = { notificationId: String(row.notificationId) };
  for (const [key, value] of Object.entries(row.data)) if (value !== null && value !== undefined) data[key] = String(value);
  if (row.type === EXCEPTION_CLOSED) {
    return { token: row.token, title: null, body: null, data, android: { priority: "high", ttlS: ALARM_TTL_S } };
  }
  if (row.type === EXCEPTION_RAISED) {
    return {
      token: row.token,
      title: row.title,
      body: row.body,
      data,
      android: { priority: "high", channelId: DECISION_CHANNEL, tag: `exception-${row.exceptionId}`, ttlS: ALARM_TTL_S },
    };
  }
  return { token: row.token, title: row.title, body: row.body, data, android: { priority: row.type === DO_SENT ? "normal" : "high" } };
}

/** Sends the pending pushes in order. A provider or network failure ends the round; that push stays pending. */
export async function sendPendingPushes(orm: Orm, sender: PushSender, now: Date): Promise<SendRound> {
  const round: SendRound = { sent: 0, rejected: 0, dropped: 0, retry: null };
  const rows = await orm
    .select({
      id: notificationDeliveries.id,
      userId: notificationDeliveries.userId,
      createdAt: notificationDeliveries.createdAt,
      deviceId: userDevices.id,
      deviceUserId: userDevices.userId,
      deviceActive: userDevices.isActive,
      token: userDevices.pushToken,
      notificationId: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      data: notifications.data,
      exceptionId: notifications.exceptionId,
      exceptionStatus: exceptions.status,
    })
    .from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .leftJoin(userDevices, eq(userDevices.id, notificationDeliveries.deviceId))
    .leftJoin(exceptions, eq(exceptions.id, notifications.exceptionId))
    .where(and(eq(notificationDeliveries.channel, "PUSH"), isNull(notificationDeliveries.sentAt), isNull(notificationDeliveries.error)))
    .orderBy(asc(notificationDeliveries.id))
    .limit(BATCH);

  const fail = (id: number, error: string) => orm.update(notificationDeliveries).set({ error }).where(eq(notificationDeliveries.id, id));
  for (const row of rows) {
    // the device signed out, or moved to another account since the push was made
    if (row.deviceId === null || !row.deviceActive || row.deviceUserId !== row.userId || row.token === null) {
      await fail(row.id, "DEVICE_INACTIVE");
      round.dropped++;
      continue;
    }
    if (now.getTime() - row.createdAt.getTime() > PUSH_MAX_AGE_MS) {
      await fail(row.id, "EXPIRED");
      round.dropped++;
      continue;
    }
    if (row.type === EXCEPTION_RAISED && row.exceptionStatus !== "PENDING") {
      await fail(row.id, "EXCEPTION_CLOSED");
      round.dropped++;
      continue;
    }
    const outcome = await sender.send(pushMessageOf({ ...row, token: row.token }));
    if (outcome.status === "SENT") {
      await orm.update(notificationDeliveries).set({ sentAt: now, providerRef: outcome.ref }).where(eq(notificationDeliveries.id, row.id));
      round.sent++;
    } else if (outcome.status === "REJECTED") {
      await fail(row.id, outcome.code);
      if (outcome.unregistered) await orm.update(userDevices).set({ isActive: false }).where(eq(userDevices.id, row.deviceId));
      round.rejected++;
    } else {
      round.retry = outcome.reason;
      break;
    }
  }
  return round;
}

export interface LoopLog {
  info: (data: object, message: string) => void;
  warn: (data: object, message: string) => void;
}

/** One round of the loop: lazy expiry, exception notifications, then the pushes when there is a provider. */
export async function runNotificationRound(orm: Orm, now: Date, sender: PushSender | null, log: Pick<LoopLog, "info" | "warn">): Promise<{ made: ExceptionRound; sent: SendRound | null }> {
  await expireStaleExceptions(orm, now);
  const made = await processExceptions(orm, now, { reminders: sender !== null });
  if (made.raised + made.reminded + made.closed > 0) log.info(made, "exception notifications made");
  if (!sender) return { made, sent: null };
  const sent = await sendPendingPushes(orm, sender, now);
  if (sent.rejected > 0) log.warn({ rejected: sent.rejected }, "pushes refused by the provider");
  return { made, sent };
}

/**
 * Runs the loop every `everyMs` until the answered function is called. A round starts only after the previous one
 * finished. `sender` null: notifications are made, pushes stay pending, no reminders.
 */
export function scheduleNotifications(orm: Orm, now: () => Date, sender: PushSender | null, log: LoopLog, everyMs = LOOP_EVERY_MS): () => Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastRetry: string | null = null;
  let current: Promise<void> | null = null;
  const start = () => {
    current = round().finally(() => {
      current = null;
    });
  };
  const round = async () => {
    try {
      const { sent } = await runNotificationRound(orm, now(), sender, log);
      // the same failure is logged once until it changes
      if (sent?.retry && sent.retry !== lastRetry) log.warn({ reason: sent.retry }, "push provider failed; pushes stay pending");
      lastRetry = sent?.retry ?? null;
    } catch (error) {
      log.warn({ err: error }, "notification round failed");
    }
    if (!stopped) {
      timer = setTimeout(start, everyMs);
      timer.unref();
    }
  };
  timer = setTimeout(start, everyMs);
  timer.unref();
  // waits for a round in progress, so the database is not closed under it
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await current;
  };
}
