// Notifications: the device and inbox routes, the DO sent to its transporter, the exception notifications made from
// the state of the exceptions (raised, reminded, closed), and the sender with a fake provider.
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client.js";
import type { PushMessage, PushOutcome, PushSender } from "../src/notifications/push.js";
import { runNotificationRound, scheduleNotifications, sendPendingPushes } from "../src/notifications/sender.js";
import { processExceptions } from "../src/notifications/service.js";
import { DESTINATION, phase3App, seedContract } from "./helpers/fixtures.js";
import { seedStaff } from "./helpers/users.js";
import { weighingApp } from "./helpers/weighing.js";

/** A provider that records what it is given and answers the queued outcomes, then SENT. */
function fakeSender(...outcomes: PushOutcome[]): PushSender & { messages: PushMessage[] } {
  const messages: PushMessage[] = [];
  return {
    provider: "fake",
    messages,
    async send(message) {
      messages.push(message);
      return outcomes.shift() ?? { status: "SENT", ref: `projects/demo/messages/${messages.length}` };
    },
  };
}

const quiet = { info: () => {}, warn: () => {} };
const TOKEN_A = `fcm-a:${"x".repeat(150)}`;
const TOKEN_B = `fcm-b:${"y".repeat(150)}`;

const deliveries = (database: Database) =>
  database.query<{ user_id: number; device_id: number | null; channel: string; sent_at: string | null; provider_ref: string | null; error: string | null; type: string }>(
    `select d.user_id::int as user_id, d.device_id::int as device_id, d.channel, d.sent_at, d.provider_ref, d.error, n.type
     from notification_deliveries d join notifications n on n.id = d.notification_id order by d.id`,
  );

async function doApp() {
  const ctx = await phase3App();
  const sale = await seedContract(ctx.database, { no: "SC-N1/UJI", direction: "OUT", partnerId: ctx.companies.customer1, productId: ctx.products.olein, qty: 500_000 });
  const makeDo = async () => {
    const created = await ctx.call("POST", "/api/delivery-orders", "logistics", {
      doDate: "2026-11-20", contractId: sale, qty: 30_000, ...DESTINATION, deliveryFrom: "2026-11-20", deliveryUntil: "2026-11-30", transporterId: ctx.companies.transporter1,
    });
    if (created.statusCode !== 201) throw new Error(created.body);
    return created.json().deliveryOrder as { id: number; doNo: string };
  };
  const register = (username: string, pushToken: string, platform = "ANDROID") => ctx.call("POST", "/api/devices", username, { platform, pushToken, appVersion: "1.0.0" });
  return { ...ctx, makeDo, register };
}

describe("devices", () => {
  it("records the token for the caller, moves a known token to the new caller, and drops its waiting pushes", async () => {
    const { register, call, ids, database, makeDo } = await doApp();
    const first = await register("angkut1", TOKEN_A);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ device: { id: expect.any(Number), platform: "ANDROID", appVersion: "1.0.0", isActive: true, lastSeenAt: expect.any(String) } });
    const order = await makeDo();
    expect((await call("POST", `/api/delivery-orders/${order.id}/send`)).statusCode).toBe(200);
    expect((await deliveries(database)).filter((row) => row.channel === "PUSH")).toEqual([
      expect.objectContaining({ user_id: ids.angkut1, device_id: first.json().device.id, sent_at: null, error: null }),
    ]);

    // the same phone, now signed in as someone else
    const moved = await register("logistics", TOKEN_A);
    expect(moved.json().device.id).toBe(first.json().device.id);
    expect(await database.query("select user_id::int as user_id, is_active from user_devices")).toEqual([{ user_id: ids.logistics, is_active: true }]);
    expect((await deliveries(database)).find((row) => row.channel === "PUSH")?.error).toBe("DEVICE_MOVED");
  });

  it("deactivates only the caller's own token on DELETE", async () => {
    const { register, call, database } = await doApp();
    await register("angkut1", TOKEN_A);
    await register("angkut2", TOKEN_B);
    const other = await call("DELETE", `/api/devices/${encodeURIComponent(TOKEN_B)}`, "angkut1");
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe("NOT_FOUND");
    const own = await call("DELETE", `/api/devices/${encodeURIComponent(TOKEN_A)}`, "angkut1");
    expect(own.statusCode).toBe(204);
    expect(await database.query("select push_token = $1 as a, is_active from user_devices order by id", [TOKEN_A])).toEqual([
      { a: true, is_active: false },
      { a: false, is_active: true },
    ]);
  });

  it("refuses a missing token or an unknown platform, and an anonymous caller", async () => {
    const { call, register } = await doApp();
    const bad = await call("POST", "/api/devices", "angkut1", { platform: "SYMBIAN", pushToken: "" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields.map((field: { field: string }) => field.field).sort()).toEqual(["platform", "pushToken"]);
    expect((await call("POST", "/api/devices", null, { platform: "ANDROID", pushToken: TOKEN_A })).statusCode).toBe(401);
    // a staff account without any permission may still register its phone
    expect((await register("qc", TOKEN_A)).statusCode).toBe(200);
  });
});

describe("a DO sent to its transporter", () => {
  it("puts one INFO notification in the inbox of the transporter's active accounts and a push per device", async () => {
    const { register, call, ids, database, makeDo, companies, seed } = await doApp();
    const inactive = await seed.seedPartnerUser(database, "angkut1-lama", companies.transporter1);
    await database.query("update users set is_active = false where id = $1", [inactive]);
    await register("angkut1", TOKEN_A);
    const order = await makeDo();
    await call("POST", `/api/delivery-orders/${order.id}/send`);

    const inbox = await call("GET", "/api/notifications", "angkut1");
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toEqual({
      items: [
        {
          id: expect.any(Number),
          type: "DO_SENT",
          severity: "INFO",
          title: "Delivery order baru",
          body: order.doNo,
          data: { type: "DO_SENT", deliveryOrderId: order.id },
          exceptionId: null,
          exceptionStatus: null,
          tripId: null,
          createdAt: expect.any(String),
          readAt: null,
        },
      ],
      unreadCount: 1,
    });
    expect((await call("GET", "/api/notifications", "angkut2")).json()).toEqual({ items: [], unreadCount: 0 });
    expect((await deliveries(database)).map((row) => [row.user_id, row.channel])).toEqual([
      [ids.angkut1, "IN_APP"],
      [ids.angkut1, "PUSH"],
    ]);

    // a DO is sent once: a second send is refused and makes nothing
    expect((await call("POST", `/api/delivery-orders/${order.id}/send`)).statusCode).toBe(409);
    expect(await database.query("select count(*)::int as n from notifications")).toEqual([{ n: 1 }]);
  });

  it("sends the push with the DO number and ids only", async () => {
    const { register, call, database, makeDo, clock } = await doApp();
    await register("angkut1", TOKEN_A);
    const order = await makeDo();
    await call("POST", `/api/delivery-orders/${order.id}/send`);
    const sender = fakeSender();
    expect(await sendPendingPushes(database.db, sender, clock.now())).toEqual({ sent: 1, rejected: 0, dropped: 0, retry: null });
    expect(sender.messages).toEqual([
      {
        token: TOKEN_A,
        title: "Delivery order baru",
        body: order.doNo,
        data: { notificationId: expect.any(String), type: "DO_SENT", deliveryOrderId: String(order.id) },
        android: { priority: "normal" },
      },
    ]);
    expect((await deliveries(database)).find((row) => row.channel === "PUSH")).toMatchObject({ sent_at: expect.anything(), provider_ref: "projects/demo/messages/1", error: null });
  });
});

describe("the inbox", () => {
  it("lists newest first, filters unread, pages, and marks one or all read for the caller only", async () => {
    const { call, makeDo } = await doApp();
    const orders = [await makeDo(), await makeDo(), await makeDo()];
    for (const order of orders) await call("POST", `/api/delivery-orders/${order.id}/send`);

    const all = (await call("GET", "/api/notifications", "angkut1")).json();
    expect(all.items.map((item: { body: string }) => item.body)).toEqual(orders.map((order) => order.doNo).reverse());
    const [newest, middle, oldest] = all.items as { id: number }[];
    expect((await call("GET", `/api/notifications?limit=1&before=${newest?.id}`, "angkut1")).json().items.map((item: { id: number }) => item.id)).toEqual([middle?.id]);

    // another account's notification is not found
    expect((await call("POST", `/api/notifications/${oldest?.id}/read`, "angkut2")).statusCode).toBe(404);
    const read = await call("POST", `/api/notifications/${oldest?.id}/read`, "angkut1");
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ notification: { id: oldest?.id, readAt: expect.any(String) }, unreadCount: 2 });
    const firstReadAt = read.json().notification.readAt;
    expect((await call("POST", `/api/notifications/${oldest?.id}/read`, "angkut1")).json().notification.readAt).toBe(firstReadAt);

    const unread = (await call("GET", "/api/notifications?unread=true", "angkut1")).json();
    expect(unread.items.map((item: { id: number }) => item.id)).toEqual([newest?.id, middle?.id]);
    expect((await call("POST", "/api/notifications/read-all", "angkut1")).json()).toEqual({ updated: 2, unreadCount: 0 });
    expect((await call("GET", "/api/notifications?unread=1", "angkut1")).json()).toEqual({ items: [], unreadCount: 0 });
    expect((await call("GET", "/api/notifications?unread=maybe", "angkut1")).statusCode).toBe(400);
  });
});

describe("exception notifications", () => {
  async function raised() {
    const ctx = await weighingApp();
    await seedStaff(ctx.database, "pengamat", { approvals: "VIEW" });
    await seedStaff(ctx.database, "qc-atasan", { qc_approvals: "EDIT" });
    const device = (await ctx.call("POST", "/api/devices", "atasan", { platform: "ANDROID", pushToken: TOKEN_A })).json().device as { id: number };
    const truck = await ctx.incoming();
    await ctx.forceReady(truck.tripId, "WEIGH_1");
    const weighed = await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: "BK1X" });
    expect(weighed.statusCode).toBe(202);
    const exceptionId = weighed.json().exception.id as number;
    const [trip] = await ctx.database.query<{ trip_no: string }>("select trip_no from trips where id = $1", [truck.tripId]);
    const atasanId = Number((await ctx.database.query<{ id: number }>("select id from users where username = 'atasan'"))[0]?.id);
    return { ...ctx, device, truck, exceptionId, tripNo: trip?.trip_no as string, atasanId };
  }

  it("tells the deciders of the module once that a request waits, with the kind and the trip number only", async () => {
    const { database, call, clock, exceptionId, truck, tripNo, atasanId } = await raised();
    expect(await processExceptions(database.db, clock.now(), { reminders: false })).toEqual({ raised: 1, reminded: 0, closed: 0 });
    expect(await processExceptions(database.db, clock.now(), { reminders: false })).toEqual({ raised: 0, reminded: 0, closed: 0 });

    const inbox = (await call("GET", "/api/notifications", "atasan")).json();
    expect(inbox.items).toEqual([
      expect.objectContaining({
        type: "EXCEPTION_RAISED",
        severity: "ALARM",
        title: "Plat nomor menunggu keputusan",
        body: tripNo,
        data: { type: "EXCEPTION_RAISED", exceptionId, tripId: truck.tripId },
        exceptionId,
        exceptionStatus: "PENDING",
        tripId: truck.tripId,
      }),
    ]);
    // VIEW is not enough, and QC holds are another module
    expect((await call("GET", "/api/notifications", "pengamat")).json().items).toEqual([]);
    expect((await call("GET", "/api/notifications", "qc-atasan")).json().items).toEqual([]);
    expect((await deliveries(database)).map((row) => [row.user_id, row.channel])).toEqual([
      [atasanId, "IN_APP"],
      [atasanId, "PUSH"],
    ]);

    const sender = fakeSender();
    await sendPendingPushes(database.db, sender, clock.now());
    expect(sender.messages).toEqual([
      {
        token: TOKEN_A,
        title: "Plat nomor menunggu keputusan",
        body: tripNo,
        data: { notificationId: expect.any(String), type: "EXCEPTION_RAISED", exceptionId: String(exceptionId), tripId: String(truck.tripId) },
        android: { priority: "high", channelId: "keputusan", tag: `exception-${exceptionId}`, ttlS: 600 },
      },
    ]);
    // nothing in the push names the plate or a weight
    expect(JSON.stringify(sender.messages)).not.toMatch(new RegExp(`${truck.plateNo}|BK1X|30000`));
  });

  it("pushes again after escalate_after_s, at most ten times, while the request waits", async () => {
    const { database, clock, exceptionId } = await raised();
    const start = clock.now();
    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
    await processExceptions(database.db, start, { reminders: true });
    // the PLATE rule repeats after 60 seconds
    expect((await processExceptions(database.db, at(59), { reminders: true })).reminded).toBe(0);
    expect((await processExceptions(database.db, at(60), { reminders: true })).reminded).toBe(1);
    expect((await processExceptions(database.db, at(60), { reminders: true })).reminded).toBe(0);
    for (let n = 2; n <= 12; n++) await processExceptions(database.db, at(60 * n), { reminders: true });
    expect(await database.query("select reminder_count from exceptions where id = $1", [exceptionId])).toEqual([{ reminder_count: 10 }]);
    expect((await deliveries(database)).filter((row) => row.channel === "PUSH")).toHaveLength(11);
    // without a provider there are no reminders
    await database.query("update exceptions set reminder_count = 0 where id = $1", [exceptionId]);
    expect((await processExceptions(database.db, at(3600), { reminders: false })).reminded).toBe(0);
  });

  it("sends a silent closing message once the request is decided, and drops its alarms not sent yet", async () => {
    const { database, call, clock, exceptionId, truck, atasanId, device } = await raised();
    await processExceptions(database.db, clock.now(), { reminders: false });
    const decided = await call("POST", `/api/exceptions/${exceptionId}/decide`, "atasan", { decision: "APPROVE", reason: "Sesuai surat jalan" });
    expect(decided.statusCode).toBe(200);

    expect((await processExceptions(database.db, clock.now(), { reminders: false })).closed).toBe(1);
    expect((await processExceptions(database.db, clock.now(), { reminders: false })).closed).toBe(0);
    expect((await deliveries(database)).filter((row) => row.type === "EXCEPTION_RAISED" || row.type === "EXCEPTION_CLOSED")).toEqual([
      expect.objectContaining({ type: "EXCEPTION_RAISED", channel: "IN_APP", user_id: atasanId }),
      expect.objectContaining({ type: "EXCEPTION_RAISED", channel: "PUSH", error: "EXCEPTION_CLOSED" }),
      expect.objectContaining({ type: "EXCEPTION_CLOSED", channel: "PUSH", user_id: atasanId, device_id: device.id, error: null }),
    ]);
    // the inbox entry stays and shows the outcome
    const [entry] = (await call("GET", "/api/notifications", "atasan")).json().items.filter((item: { exceptionId: number }) => item.exceptionId === exceptionId);
    expect(entry).toMatchObject({ type: "EXCEPTION_RAISED", exceptionStatus: "APPROVED" });

    const sender = fakeSender();
    await sendPendingPushes(database.db, sender, clock.now());
    expect(sender.messages.filter((message) => message.data.exceptionId === String(exceptionId))).toEqual([
      { token: TOKEN_A, title: null, body: null, data: { notificationId: expect.any(String), type: "EXCEPTION_CLOSED", exceptionId: String(exceptionId), tripId: String(truck.tripId) }, android: { priority: "high", ttlS: 600 } },
    ]);
  });

  it("also closes a request the weighbridge stopped asking about, through the lazy expiry in the round", async () => {
    const { database, clock, exceptionId } = await raised();
    await runNotificationRound(database.db, clock.now(), null, quiet);
    clock.advance(11_000);
    expect((await runNotificationRound(database.db, clock.now(), null, quiet)).made).toEqual({ raised: 0, reminded: 0, closed: 1 });
    expect(await database.query("select status from exceptions where id = $1", [exceptionId])).toEqual([{ status: "CANCELLED" }]);
  });
});

describe("the sender", () => {
  async function pending() {
    const ctx = await doApp();
    const device = (await ctx.register("angkut1", TOKEN_A)).json().device as { id: number };
    const order = await ctx.makeDo();
    await ctx.call("POST", `/api/delivery-orders/${order.id}/send`);
    const push = async () => (await deliveries(ctx.database)).find((row) => row.channel === "PUSH");
    return { ...ctx, device, push };
  }

  it("without a provider leaves the pushes as they are", async () => {
    const { database, push, clock } = await pending();
    expect((await runNotificationRound(database.db, clock.now(), null, quiet)).sent).toBeNull();
    expect(await push()).toMatchObject({ sent_at: null, error: null });
  });

  it("records a refusal, and makes a device whose token is unregistered inactive", async () => {
    const { database, push, device, clock } = await pending();
    const sender = fakeSender({ status: "REJECTED", code: "UNREGISTERED", httpStatus: 404, unregistered: true });
    expect(await sendPendingPushes(database.db, sender, clock.now())).toEqual({ sent: 0, rejected: 1, dropped: 0, retry: null });
    expect(await push()).toMatchObject({ sent_at: null, error: "UNREGISTERED" });
    expect(await database.query("select is_active from user_devices where id = $1", [device.id])).toEqual([{ is_active: false }]);
  });

  it("keeps the push pending when the provider fails, and sends it in a later round", async () => {
    const { database, push, clock } = await pending();
    const sender = fakeSender({ status: "RETRY", reason: "UNAVAILABLE", httpStatus: 503 });
    expect(await sendPendingPushes(database.db, sender, clock.now())).toEqual({ sent: 0, rejected: 0, dropped: 0, retry: "UNAVAILABLE" });
    expect(await push()).toMatchObject({ sent_at: null, error: null });
    expect((await sendPendingPushes(database.db, sender, clock.now())).sent).toBe(1);
  });

  it("drops a push that waited more than ten minutes, or whose device signed out", async () => {
    const first = await pending();
    const late = new Date(first.clock.now().getTime() + 10 * 60_000 + 5_000);
    expect(await sendPendingPushes(first.database.db, fakeSender(), late)).toEqual({ sent: 0, rejected: 0, dropped: 1, retry: null });
    expect(await first.push()).toMatchObject({ error: "EXPIRED" });

    const second = await pending();
    await second.call("DELETE", `/api/devices/${encodeURIComponent(TOKEN_A)}`, "angkut1");
    const sender = fakeSender();
    expect((await sendPendingPushes(second.database.db, sender, second.clock.now())).dropped).toBe(1);
    expect(sender.messages).toEqual([]);
    expect(await second.push()).toMatchObject({ error: "DEVICE_INACTIVE" });
  });

  it("does not run in the application unless it is started, and stops when asked", async () => {
    const sender = fakeSender();
    const { database, clock } = await pending();
    // the test application was built without the loop: the push waits
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sender.messages).toEqual([]);

    const stop = scheduleNotifications(database.db, clock.now, sender, quiet, 10);
    await vi.waitFor(() => expect(sender.messages).toHaveLength(1));
    await stop();
    const after = sender.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sender.messages).toHaveLength(after);
  });
});
