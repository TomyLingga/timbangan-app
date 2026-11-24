// The inbox of the signed-in account (apps/api src/notifications/routes.ts): its entries, where each one leads,
// and the number on the header bell. Types the page does not know are listed with their title and body and lead
// nowhere.

import { formatDate } from "@/lib/format";
import { exceptionStatusInfo } from "@/lib/weighing";

export type NotificationSeverity = "INFO" | "WARNING" | "ALARM";

export interface NotificationItem {
  id: number | string;
  /** EXCEPTION_RAISED and DO_SENT today; any other value is shown as a plain entry. */
  type: string;
  severity: NotificationSeverity | string;
  title: string;
  body: string;
  data: Record<string, string | number> | null;
  exceptionId: number | string | null;
  /** The state of the request now, for EXCEPTION_RAISED; null for other types. */
  exceptionStatus: string | null;
  tripId: number | string | null;
  createdAt: string;
  readAt: string | null;
}

/** GET /api/notifications */
export interface NotificationPage {
  items: NotificationItem[];
  unreadCount: number;
}

/** POST /api/notifications/:id/read */
export interface NotificationRead {
  notification: NotificationItem | undefined;
  unreadCount: number;
}

/** POST /api/notifications/read-all */
export interface NotificationsReadAll {
  updated: number;
  unreadCount: number;
}

export const EXCEPTION_RAISED = "EXCEPTION_RAISED";
export const DO_SENT = "DO_SENT";

/** The query parameter of /keputusan that opens one request. */
export const DECISION_PARAM = "permintaan";

/** /keputusan, or /keputusan with one request open. */
export function decisionsHref(exceptionId?: number | string | null): string {
  if (exceptionId === undefined || exceptionId === null || exceptionId === "") return "/keputusan";
  return `/keputusan?${new URLSearchParams({ [DECISION_PARAM]: String(exceptionId) })}`;
}

function dataValue(item: NotificationItem, key: string): string | number | null {
  const value = item.data?.[key];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/**
 * The page an entry leads to, or null when it leads nowhere: a delivery order to its page, a request to where it
 * is decided (only for an account that may open Keputusan), anything else nowhere.
 */
export function notificationTarget(item: NotificationItem, access: { canOpenDecisions: boolean }): string | null {
  if (item.type === DO_SENT) {
    const id = dataValue(item, "deliveryOrderId");
    return id === null || id === "" ? null : `/delivery-order/${encodeURIComponent(String(id))}`;
  }
  if (item.type === EXCEPTION_RAISED) {
    if (!access.canOpenDecisions) return null;
    const id = item.exceptionId ?? dataValue(item, "exceptionId");
    return id === null || id === "" ? null : decisionsHref(id);
  }
  return null;
}

/** Whether a request entry is still waiting, as a line under it; null for other entries. */
export function requestStateText(item: NotificationItem): { text: string; waiting: boolean } | null {
  if (item.type !== EXCEPTION_RAISED || !item.exceptionStatus) return null;
  switch (item.exceptionStatus) {
    case "PENDING":
      return { text: "Menunggu keputusan", waiting: true };
    case "APPROVED":
    case "REJECTED":
    case "RETRY":
      return { text: `Sudah diputuskan: ${exceptionStatusInfo(item.exceptionStatus).label.toLowerCase()}`, waiting: false };
    default:
      // CANCELLED, EXPIRED, or a status added later
      return { text: exceptionStatusInfo(item.exceptionStatus).label, waiting: false };
  }
}

/** Requests read for the bell of an account that may decide them; this many or more shows as "50+". */
export const WAITING_LIMIT = 50;
/** An unread count above this shows as "99+". */
const UNREAD_SHOWN_MAX = 99;

export type BellNumber =
  | { kind: "approvals"; count: number; capped: boolean }
  | { kind: "unread"; count: number; capped: boolean }
  | { kind: "approvals" | "unread"; count: null; capped: false };

/**
 * The number on the bell. An account that may open Keputusan sees the requests waiting (a waiting request holds a
 * truck), every other account its unread count. The two are never added. Null when the count did not load.
 */
export function bellNumber(input: { approver: boolean; waiting: number | null | undefined; unread: number | null | undefined }): BellNumber {
  if (input.approver) {
    if (typeof input.waiting !== "number") return { kind: "approvals", count: null, capped: false };
    return { kind: "approvals", count: input.waiting, capped: input.waiting >= WAITING_LIMIT };
  }
  if (typeof input.unread !== "number") return { kind: "unread", count: null, capped: false };
  return { kind: "unread", count: input.unread, capped: input.unread > UNREAD_SHOWN_MAX };
}

/** The figure in the badge, or null when there is no badge. */
export function bellBadge(bell: BellNumber): string | null {
  if (bell.count === null || bell.count <= 0) return null;
  if (bell.kind === "approvals") return bell.capped ? `${WAITING_LIMIT}+` : String(bell.count);
  return bell.capped ? `${UNREAD_SHOWN_MAX}+` : String(bell.count);
}

/** The accessible name of the bell, with the number in it. */
export function bellLabel(bell: BellNumber): string {
  if (bell.count === null) return "Pemberitahuan";
  if (bell.kind === "approvals") {
    if (bell.count === 0) return "Pemberitahuan, tidak ada permintaan menunggu keputusan";
    return bell.capped ? `${WAITING_LIMIT} atau lebih permintaan menunggu keputusan` : `${bell.count} permintaan menunggu keputusan`;
  }
  if (bell.count === 0) return "Pemberitahuan, semua sudah dibaca";
  return `${bell.count} pemberitahuan belum dibaca`;
}

/** "baru saja", "5 mnt lalu", "3 jam lalu", "2 hari lalu", then the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "-";
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 45) return "baru saja";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} mnt lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} hari lalu`;
  return formatDate(iso);
}
