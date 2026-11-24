import { describe, expect, it, vi } from "vitest";
import type { NotificationItem, NotificationListResponse } from "../api/types";
import { appendPage, cursorOf, EMPTY_INBOX, firstPage, itemTarget, loadPage, loadUnreadCount, markAllRead, markRead, requestBadge, withAllRead, withRead } from "./inbox";

const item = (id: number, extra: Partial<NotificationItem> = {}): NotificationItem => ({
  id,
  type: "EXCEPTION_RAISED",
  severity: "ALARM",
  title: "Selisih bruto",
  body: "Trip TR-0012",
  data: null,
  exceptionId: 900 + id,
  exceptionStatus: "PENDING",
  tripId: 112,
  createdAt: "2026-11-24T03:00:00.000Z",
  readAt: null,
  ...extra,
});
const page = (ids: number[], unreadCount: number): NotificationListResponse => ({ items: ids.map((id) => item(id)), unreadCount });

function fakeApi(answer: unknown) {
  const request = vi.fn(async (..._args: unknown[]) => answer);
  return { api: { request } as never, request };
}

describe("inbox paging", () => {
  it("asks for the newest page, then the page before the oldest id shown", async () => {
    const { api, request } = fakeApi(page([5], 1));
    await loadPage(api);
    await loadPage(api, 31, 20);
    expect(request.mock.calls[0]).toEqual(["/api/notifications", { query: { limit: 20, before: undefined } }]);
    expect(request.mock.calls[1]).toEqual(["/api/notifications", { query: { limit: 20, before: 31 } }]);
  });
  it("knows more may exist only after a full page", () => {
    const full = firstPage(page([50, 49, 48], 2), 3);
    expect(full.hasMore).toBe(true);
    expect(cursorOf(full)).toBe(48);
    const short = firstPage(page([50, 49], 2), 3);
    expect(short.hasMore).toBe(false);
    expect(cursorOf(EMPTY_INBOX)).toBeUndefined();
  });
  it("adds the older page without showing an entry twice", () => {
    const one = firstPage(page([50, 49, 48], 3), 3);
    const two = appendPage(one, page([48, 47], 2), 3);
    expect(two.items.map((entry) => entry.id)).toEqual([50, 49, 48, 47]);
    expect(two.unreadCount).toBe(2);
    expect(two.hasMore).toBe(false);
  });
  it("reads the unread count alone", async () => {
    const { api, request } = fakeApi(page([], 7));
    expect(await loadUnreadCount(api)).toBe(7);
    expect(request.mock.calls[0]).toEqual(["/api/notifications", { query: { unread: "true", limit: 1 } }]);
  });
});

describe("read state", () => {
  const now = new Date("2026-11-24T05:00:00.000Z");
  const start = firstPage({ items: [item(3), item(2), item(1, { readAt: "2026-11-24T04:00:00.000Z" })], unreadCount: 2 });

  it("marks one entry from the server's answer", async () => {
    const { api, request } = fakeApi({ notification: item(3, { readAt: "2026-11-24T05:00:01.000Z" }), unreadCount: 1 });
    const answer = await markRead(api, 3);
    expect(request.mock.calls[0]).toEqual(["/api/notifications/3/read", { method: "POST" }]);
    const next = withRead(start, 3, answer, now);
    expect(next.items[0]?.readAt).toBe("2026-11-24T05:00:01.000Z");
    expect(next.unreadCount).toBe(1);
  });
  it("marks one entry here while the answer is out, and does not count an entry read twice", () => {
    const once = withRead(start, 2, null, now);
    expect(once.items[1]?.readAt).toBe(now.toISOString());
    expect(once.unreadCount).toBe(1);
    expect(withRead(once, 2, null, now).unreadCount).toBe(1);
    expect(withRead(start, 1, null, now).unreadCount).toBe(2);
  });
  it("marks all entries", async () => {
    const { api, request } = fakeApi({ updated: 2, unreadCount: 0 });
    await markAllRead(api);
    expect(request.mock.calls[0]).toEqual(["/api/notifications/read-all", { method: "POST" }]);
    const next = withAllRead(start, now);
    expect(next.items.map((entry) => entry.readAt)).toEqual([now.toISOString(), now.toISOString(), "2026-11-24T04:00:00.000Z"]);
    expect(next.unreadCount).toBe(0);
  });
});

describe("what an entry shows and opens", () => {
  it("a request opens its decision screen, also once closed; a delivery order opens nothing", () => {
    expect(itemTarget(item(1))).toBe(901);
    expect(itemTarget(item(2, { type: "EXCEPTION_CLOSED" }))).toBe(902);
    expect(itemTarget(item(3, { type: "DO_SENT", exceptionId: null, exceptionStatus: null }))).toBeNull();
  });
  it("says whether the request still waits", () => {
    expect(requestBadge(item(1))).toEqual({ label: "Masih menunggu", tone: "warn" });
    expect(requestBadge(item(1, { exceptionStatus: "APPROVED" }))).toEqual({ label: "Disetujui", tone: "ok" });
    expect(requestBadge(item(1, { exceptionStatus: "CANCELLED" }))).toEqual({ label: "Batal (truk turun dari timbangan)", tone: "plain" });
    expect(requestBadge(item(1, { exceptionId: null, exceptionStatus: null }))).toBeNull();
  });
});
