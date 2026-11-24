import { describe, expect, it } from "vitest";

import {
  bellBadge,
  bellLabel,
  bellNumber,
  decisionsHref,
  notificationTarget,
  relativeTime,
  requestStateText,
  type NotificationItem,
} from "@/lib/notifications";

const item = (fields: Partial<NotificationItem>): NotificationItem => ({
  id: 1,
  type: "DO_SENT",
  severity: "INFO",
  title: "Delivery order baru",
  body: "001/DO/CTH/XI/2026",
  data: null,
  exceptionId: null,
  exceptionStatus: null,
  tripId: null,
  createdAt: "2026-11-24T03:00:00.000Z",
  readAt: null,
  ...fields,
});

const staff = { canOpenDecisions: true };
const partner = { canOpenDecisions: false };

describe("notificationTarget", () => {
  it("leads a sent delivery order to its page", () => {
    const sent = item({ type: "DO_SENT", data: { type: "DO_SENT", deliveryOrderId: 42 } });
    expect(notificationTarget(sent, partner)).toBe("/delivery-order/42");
    expect(notificationTarget(sent, staff)).toBe("/delivery-order/42");
  });

  it("leads a delivery order without an id nowhere", () => {
    expect(notificationTarget(item({ type: "DO_SENT", data: { type: "DO_SENT" } }), partner)).toBeNull();
  });

  it("leads a request to Keputusan with that request open", () => {
    const raised = item({ type: "EXCEPTION_RAISED", severity: "ALARM", exceptionId: 7, data: { type: "EXCEPTION_RAISED", exceptionId: 7, tripId: 3 } });
    expect(notificationTarget(raised, staff)).toBe("/keputusan?permintaan=7");
  });

  it("falls back to the request id in data", () => {
    const raised = item({ type: "EXCEPTION_RAISED", exceptionId: null, data: { exceptionId: "x-2" } });
    expect(notificationTarget(raised, staff)).toBe("/keputusan?permintaan=x-2");
  });

  it("leads a request nowhere for an account that cannot open Keputusan", () => {
    const raised = item({ type: "EXCEPTION_RAISED", exceptionId: 7 });
    expect(notificationTarget(raised, partner)).toBeNull();
  });

  it("leads a type it does not know nowhere", () => {
    expect(notificationTarget(item({ type: "SITE_NOTICE", data: { deliveryOrderId: 1 } }), staff)).toBeNull();
  });
});

describe("decisionsHref", () => {
  it("is the plain page without a request", () => {
    expect(decisionsHref()).toBe("/keputusan");
    expect(decisionsHref(null)).toBe("/keputusan");
  });

  it("encodes the request id", () => {
    expect(decisionsHref("a b")).toBe("/keputusan?permintaan=a+b");
  });
});

describe("requestStateText", () => {
  const raised = (exceptionStatus: string | null) => item({ type: "EXCEPTION_RAISED", exceptionStatus });

  it("says a pending request is still waiting", () => {
    expect(requestStateText(raised("PENDING"))).toEqual({ text: "Menunggu keputusan", waiting: true });
  });

  it("says a decided request was decided and how", () => {
    expect(requestStateText(raised("APPROVED"))).toEqual({ text: "Sudah diputuskan: disetujui", waiting: false });
    expect(requestStateText(raised("REJECTED"))).toEqual({ text: "Sudah diputuskan: ditolak", waiting: false });
  });

  it("names a request closed without a decision", () => {
    expect(requestStateText(raised("EXPIRED"))).toEqual({ text: "Kedaluwarsa", waiting: false });
    expect(requestStateText(raised("CANCELLED"))).toEqual({ text: "Batal", waiting: false });
  });

  it("says nothing for other entries or a missing status", () => {
    expect(requestStateText(item({ type: "DO_SENT" }))).toBeNull();
    expect(requestStateText(raised(null))).toBeNull();
  });
});

describe("bellNumber", () => {
  it("counts the requests waiting for an account that may decide them, never adding the unread count", () => {
    expect(bellNumber({ approver: true, waiting: 3, unread: 8 })).toEqual({ kind: "approvals", count: 3, capped: false });
    expect(bellNumber({ approver: true, waiting: 0, unread: 8 })).toEqual({ kind: "approvals", count: 0, capped: false });
  });

  it("counts the unread entries for every other account", () => {
    expect(bellNumber({ approver: false, waiting: 3, unread: 2 })).toEqual({ kind: "unread", count: 2, capped: false });
  });

  it("has no number when the count did not load", () => {
    expect(bellNumber({ approver: true, waiting: undefined, unread: 2 }).count).toBeNull();
    expect(bellNumber({ approver: false, waiting: 3, unread: null }).count).toBeNull();
  });

  it("caps the waiting list at its read limit and the unread count above 99", () => {
    expect(bellNumber({ approver: true, waiting: 50, unread: 0 }).capped).toBe(true);
    expect(bellNumber({ approver: false, waiting: 0, unread: 100 }).capped).toBe(true);
    expect(bellNumber({ approver: false, waiting: 0, unread: 99 }).capped).toBe(false);
  });
});

describe("bellBadge", () => {
  it("shows the count, or none at zero or when unknown", () => {
    expect(bellBadge(bellNumber({ approver: false, waiting: null, unread: 4 }))).toBe("4");
    expect(bellBadge(bellNumber({ approver: false, waiting: null, unread: 0 }))).toBeNull();
    expect(bellBadge(bellNumber({ approver: false, waiting: null, unread: undefined }))).toBeNull();
  });

  it("shows the caps", () => {
    expect(bellBadge(bellNumber({ approver: true, waiting: 50, unread: 0 }))).toBe("50+");
    expect(bellBadge(bellNumber({ approver: false, waiting: 0, unread: 250 }))).toBe("99+");
  });
});

describe("bellLabel", () => {
  it("says the unread count in words", () => {
    expect(bellLabel(bellNumber({ approver: false, waiting: null, unread: 3 }))).toBe("3 pemberitahuan belum dibaca");
    expect(bellLabel(bellNumber({ approver: false, waiting: null, unread: 0 }))).toBe("Pemberitahuan, semua sudah dibaca");
  });

  it("says the requests waiting for an account that may decide them", () => {
    expect(bellLabel(bellNumber({ approver: true, waiting: 3, unread: 9 }))).toBe("3 permintaan menunggu keputusan");
    expect(bellLabel(bellNumber({ approver: true, waiting: 0, unread: 9 }))).toBe("Pemberitahuan, tidak ada permintaan menunggu keputusan");
    expect(bellLabel(bellNumber({ approver: true, waiting: 60, unread: 0 }))).toBe("50 atau lebih permintaan menunggu keputusan");
  });

  it("names only the bell when the count did not load", () => {
    expect(bellLabel(bellNumber({ approver: true, waiting: undefined, unread: 1 }))).toBe("Pemberitahuan");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-24T10:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("says just now under 45 seconds, also for a time slightly ahead", () => {
    expect(relativeTime(ago(10_000), now)).toBe("baru saja");
    expect(relativeTime(ago(-30_000), now)).toBe("baru saja");
  });

  it("counts minutes, hours and days", () => {
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5 mnt lalu");
    expect(relativeTime(ago(59 * 60_000), now)).toBe("59 mnt lalu");
    expect(relativeTime(ago(3 * 3_600_000 + 10 * 60_000), now)).toBe("3 jam lalu");
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe("2 hari lalu");
  });

  it("gives the date from a week back", () => {
    expect(relativeTime("2026-11-10T03:00:00.000Z", now)).toBe("10 Nov 2026");
  });

  it("gives a dash for a value that is not a time", () => {
    expect(relativeTime("kemarin", now)).toBe("-");
  });
});
