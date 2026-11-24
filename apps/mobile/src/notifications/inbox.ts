// The inbox ("Pemberitahuan"): pages from GET /api/notifications (newest first, the next page starts before the
// id of the last item), the read state, and what an entry shows and opens. No React Native imports.

import type { ApiClient } from "../api/client";
import type { NotificationItem, NotificationListResponse, NotificationReadAllResponse, NotificationReadResponse } from "../api/types";
import { STATUS_TEXT } from "../decisions/decision";
import type { Tone } from "../forms/shared";
import { EXCEPTION_CLOSED, EXCEPTION_RAISED } from "./push";

export const INBOX_PAGE = 20;

type Requester = Pick<ApiClient, "request">;

export interface InboxState {
  items: NotificationItem[];
  unreadCount: number;
  /** A full page came back last time, so older entries may exist. */
  hasMore: boolean;
}

export const EMPTY_INBOX: InboxState = { items: [], unreadCount: 0, hasMore: false };

/** The page before `before` (an id), or the newest page. */
export function loadPage(api: Requester, before?: number, limit = INBOX_PAGE): Promise<NotificationListResponse> {
  return api.request<NotificationListResponse>("/api/notifications", { query: { limit, before } });
}

/** Only the number of unread entries. */
export async function loadUnreadCount(api: Requester): Promise<number> {
  const answer = await api.request<NotificationListResponse>("/api/notifications", { query: { unread: "true", limit: 1 } });
  return answer.unreadCount;
}

export function firstPage(answer: NotificationListResponse, limit = INBOX_PAGE): InboxState {
  return { items: answer.items, unreadCount: answer.unreadCount, hasMore: answer.items.length >= limit };
}

/** Adds an older page; an entry already listed (a new one moved the page) is not shown twice. */
export function appendPage(state: InboxState, answer: NotificationListResponse, limit = INBOX_PAGE): InboxState {
  const known = new Set(state.items.map((item) => item.id));
  return {
    items: [...state.items, ...answer.items.filter((item) => !known.has(item.id))],
    unreadCount: answer.unreadCount,
    hasMore: answer.items.length >= limit,
  };
}

/** The `before` of the next page: the id of the oldest entry shown. */
export const cursorOf = (state: InboxState): number | undefined => state.items.at(-1)?.id;

export async function markRead(api: Requester, id: number): Promise<NotificationReadResponse> {
  return api.request<NotificationReadResponse>(`/api/notifications/${id}/read`, { method: "POST" });
}

export async function markAllRead(api: Requester): Promise<NotificationReadAllResponse> {
  return api.request<NotificationReadAllResponse>("/api/notifications/read-all", { method: "POST" });
}

/** One entry read: the server's copy of it and its count when there is an answer, otherwise marked here. */
export function withRead(state: InboxState, id: number, answer: NotificationReadResponse | null, now: Date = new Date()): InboxState {
  const wasUnread = state.items.some((item) => item.id === id && item.readAt === null);
  return {
    ...state,
    items: state.items.map((item) => (item.id !== id ? item : (answer?.notification ?? { ...item, readAt: item.readAt ?? now.toISOString() }))),
    unreadCount: answer ? answer.unreadCount : Math.max(0, state.unreadCount - (wasUnread ? 1 : 0)),
  };
}

export function withAllRead(state: InboxState, now: Date = new Date()): InboxState {
  const at = now.toISOString();
  return { ...state, items: state.items.map((item) => (item.readAt === null ? { ...item, readAt: at } : item)), unreadCount: 0 };
}

/** A request entry opens its decision screen (also once it is closed, to show the outcome); other entries open nothing. */
export function itemTarget(item: NotificationItem): number | null {
  return (item.type === EXCEPTION_RAISED || item.type === EXCEPTION_CLOSED) && item.exceptionId !== null ? item.exceptionId : null;
}

/** For a request: whether it still waits, or what became of it. */
export function requestBadge(item: NotificationItem): { label: string; tone: Tone } | null {
  if (item.exceptionId === null || !item.exceptionStatus) return null;
  if (item.exceptionStatus === "PENDING") return { label: "Masih menunggu", tone: "warn" };
  return { label: STATUS_TEXT[item.exceptionStatus] ?? item.exceptionStatus, tone: item.exceptionStatus === "APPROVED" ? "ok" : "plain" };
}
