// Mock of the inbox of apps/api src/notifications (routes.ts and service.ts), for dev/mock-api.mjs. Every number
// and text is made up.
//
// What the accounts of the mock find in their inbox:
//   admin.contoh, super.contoh, petugas.lokal   (approvals and qc_approvals EDIT) one request notification per
//                                               request of the sample flow: the waiting ones unread, the decided one
//                                               read; plus a notice of a type the web does not know
//   manajer.qc                                  (qc_approvals EDIT) the QC hold, and the notice
//   pengawas.timbang, keputusan.timbang         (approvals EDIT) the weighbridge requests, and the notice
//   transporter.contoh                          the seeded DO sent to its company (unread), the notice (unread), and
//                                               twelve older delivery orders (read), so "Muat lagi" has a next page
//   pos.contoh                                  the notice only
//   pks.contoh.a                                nothing (the empty inbox)
// A DO sent through POST /api/delivery-orders/:id/send adds one for the accounts of its transporter, and a request
// raised later gets its notification on the next inbox read, the way the API's loop finds it.

export const EXCEPTION_RAISED = "EXCEPTION_RAISED";
export const DO_SENT = "DO_SENT";

/** The titles of apps/api src/notifications/service.ts. */
const EXCEPTION_TITLES = {
  PLATE: "Plat nomor menunggu keputusan",
  GROSS_IN: "Selisih bruto menunggu keputusan",
  TARE_OUT: "Selisih tarra menunggu keputusan",
  NET_IN: "Selisih netto menunggu keputusan",
  NET_OUT: "Netto muat menunggu keputusan",
  QC_HOLD: "Hasil QC menunggu keputusan",
};
const DO_SENT_TITLE = "Delivery order baru";

const LIMIT_MESSAGE = "limit harus bilangan bulat 1 sampai 50.";

export function createNotificationsMock({ authenticate, send, fail, invalid, users, can, exceptions, trips, deliveryOrders }) {
  let nextId = 1;
  /** { id, type, severity, title, body, data, exceptionId, tripId, createdAt } */
  const notifications = [];
  /** The IN_APP rows: { notificationId, userId, readAt } */
  const deliveries = [];

  function add(fields, userIds, { readBy = [], createdAt = new Date().toISOString() } = {}) {
    const row = { id: nextId++, exceptionId: null, tripId: null, ...fields, createdAt };
    notifications.push(row);
    for (const userId of new Set(userIds)) {
      deliveries.push({ notificationId: row.id, userId, readAt: readBy.includes(userId) ? createdAt : null });
    }
    return row;
  }

  const activeUser = (user) => user.isActive !== false;
  /** Staff holding the module at EDIT, as `deciders` of the API picks them. */
  const decidersOf = (moduleCode) => users.filter((user) => activeUser(user) && user.kind === "INTERNAL" && can(user, moduleCode, "EDIT")).map((user) => user.id);
  const accountsOf = (partnerId) => users.filter((user) => activeUser(user) && user.kind === "PARTNER" && user.partner?.id === partnerId).map((user) => user.id);

  function raised(row, options) {
    const trip = trips.find((item) => item.id === row.tripId);
    return add(
      {
        type: EXCEPTION_RAISED,
        severity: "ALARM",
        title: EXCEPTION_TITLES[row.type] ?? row.type,
        body: trip?.tripNo ?? `Trip #${row.tripId}`,
        data: { type: EXCEPTION_RAISED, exceptionId: row.id, tripId: row.tripId },
        exceptionId: row.id,
        tripId: row.tripId,
      },
      decidersOf(row.approverModule ?? "approvals"),
      options,
    );
  }

  /** A DO sent to its transporter: the active accounts of that company get one INFO notification. */
  function deliveryOrderSent(order, options) {
    return add(
      { type: DO_SENT, severity: "INFO", title: DO_SENT_TITLE, body: order.doNo, data: { type: DO_SENT, deliveryOrderId: order.id } },
      accountsOf(order.transporterId),
      options,
    );
  }

  /** Requests still waiting without a notification get one, like one round of processExceptions. */
  function catchUp() {
    for (const row of exceptions) {
      if (row.status === "PENDING" && !notifications.some((item) => item.type === EXCEPTION_RAISED && item.exceptionId === row.id)) raised(row);
    }
  }

  // --- seed, oldest first so the ids follow the time --------------------------------------------------------------
  const transporterAccounts = users.filter((user) => user.username === "transporter.contoh").map((user) => user.id);
  const sentOrder = deliveryOrders.find((order) => order.status === "SENT" && order.transporterId);
  if (sentOrder) {
    const transporterId = sentOrder.transporterId;
    for (let index = 12; index >= 1; index -= 1) {
      // older delivery orders of the company that are no longer in the mock's list; they lead to "not found"
      const createdAt = new Date(Date.now() - (index + 2) * 86_400_000).toISOString();
      add(
        { type: DO_SENT, severity: "INFO", title: DO_SENT_TITLE, body: `9${String(index).padStart(2, "0")}/DO/CTH/X/2026`, data: { type: DO_SENT, deliveryOrderId: `do-lama-${index}` } },
        accountsOf(transporterId),
        { createdAt, readBy: accountsOf(transporterId) },
      );
    }
  }
  for (const row of [...exceptions].sort((a, b) => a.raisedAt.localeCompare(b.raisedAt))) {
    const recipients = decidersOf(row.approverModule ?? "approvals");
    raised(row, { createdAt: row.raisedAt, readBy: row.status === "PENDING" ? [] : recipients });
  }
  if (sentOrder) deliveryOrderSent(sentOrder, { createdAt: sentOrder.sentAt ?? new Date().toISOString() });
  // a type the web does not know yet: listed with its title and body, leading nowhere
  const noticeTo = users.filter((user) => user.username !== "pks.contoh.a" && (user.kind === "PARTNER" ? transporterAccounts.includes(user.id) : Object.keys(user.permissions).length > 0));
  add(
    { type: "SITE_NOTICE", severity: "WARNING", title: "Jam timbang berubah", body: "Timbangan tutup Minggu pukul 08.00 sampai 12.00 untuk kalibrasi (contoh).", data: { type: "SITE_NOTICE" } },
    noticeTo.map((user) => user.id),
    { createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
  );

  // --- the inbox as the API answers it ----------------------------------------------------------------------------
  function view(row, delivery) {
    const exception = row.exceptionId === null ? null : exceptions.find((item) => item.id === row.exceptionId);
    return {
      id: row.id,
      type: row.type,
      severity: row.severity,
      title: row.title,
      body: row.body,
      data: row.data,
      exceptionId: row.exceptionId,
      exceptionStatus: exception?.status ?? null,
      tripId: row.tripId,
      createdAt: row.createdAt,
      readAt: delivery.readAt,
    };
  }
  const mine = (user) => deliveries.filter((delivery) => delivery.userId === user.id);
  const unreadCount = (user) => mine(user).filter((delivery) => delivery.readAt === null).length;
  const entryOf = (delivery) => notifications.find((row) => row.id === delivery.notificationId);

  const routes = {
    "GET /api/notifications": (request, response, url) => {
      const user = authenticate(request, response);
      if (!user) return 0;
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 20 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return invalid(request, response, { limit: LIMIT_MESSAGE });
      const unread = ["true", "1"].includes(url.searchParams.get("unread") ?? "");
      const before = url.searchParams.get("before");
      if (before !== null && !(Number.isInteger(Number(before)) && Number(before) > 0)) return invalid(request, response, { before: "Id tidak valid." });
      catchUp();
      const items = mine(user)
        .filter((delivery) => (!unread || delivery.readAt === null) && (before === null || delivery.notificationId < Number(before)))
        .sort((a, b) => b.notificationId - a.notificationId)
        .slice(0, limit)
        .map((delivery) => view(entryOf(delivery), delivery));
      return send(request, response, 200, { items, unreadCount: unreadCount(user) });
    },

    "POST /api/notifications/read-all": (request, response) => {
      const user = authenticate(request, response);
      if (!user) return 0;
      const now = new Date().toISOString();
      let updated = 0;
      for (const delivery of mine(user)) {
        if (delivery.readAt === null) {
          delivery.readAt = now;
          updated += 1;
        }
      }
      return send(request, response, 200, { updated, unreadCount: 0 });
    },

    "POST /api/notifications/:id/read": (request, response, url, id) => {
      const user = authenticate(request, response);
      if (!user) return 0;
      const delivery = mine(user).find((item) => String(item.notificationId) === id);
      if (!delivery) return fail(request, response, 404, "NOT_FOUND", "Pemberitahuan tidak ditemukan.");
      // a second call keeps the first time
      delivery.readAt ??= new Date().toISOString();
      return send(request, response, 200, { notification: view(entryOf(delivery), delivery), unreadCount: unreadCount(user) });
    },
  };

  return { routes, deliveryOrderSent };
}
