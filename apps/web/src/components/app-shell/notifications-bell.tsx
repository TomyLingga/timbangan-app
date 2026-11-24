"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Bell, Loader2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApiQuery } from "@/hooks/use-api-query";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { formatDateTime } from "@/lib/format";
import {
  DO_SENT,
  EXCEPTION_RAISED,
  WAITING_LIMIT,
  bellBadge,
  bellLabel,
  bellNumber,
  notificationTarget,
  relativeTime,
  requestStateText,
  type NotificationItem,
  type NotificationPage,
  type NotificationRead,
  type NotificationsReadAll,
} from "@/lib/notifications";
import { canSeeApprovals } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { ExceptionView, User } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The requests waiting, as the bell of the approvers counted them before the inbox. */
const WAITING_REFRESH_MS = 15_000;
const UNREAD_REFRESH_MS = 30_000;
const PAGE_SIZE = 10;

interface Inbox {
  status: "idle" | "loading" | "ready" | "error";
  items: NotificationItem[];
  hasMore: boolean;
  more: "idle" | "loading" | "error";
  unread: number | null;
}

const EMPTY_INBOX: Inbox = { status: "idle", items: [], hasMore: false, more: "idle", unread: null };

/** Adds a page under the entries already shown, without repeating one. */
function appendPage(items: NotificationItem[], page: NotificationItem[]): NotificationItem[] {
  const known = new Set(items.map((item) => String(item.id)));
  return [...items, ...page.filter((item) => !known.has(String(item.id)))];
}

function Entry({ item, href, now, onFollow }: { item: NotificationItem; href: string | null; now: number; onFollow: (item: NotificationItem) => void }) {
  const unread = item.readAt === null;
  const state = requestStateText(item);
  // the body of the known types is a document or trip number
  const codeBody = item.type === DO_SENT || item.type === EXCEPTION_RAISED;
  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", unread ? (item.severity === "ALARM" ? "bg-signal" : "bg-primary") : "bg-transparent")}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-3">
          <span className={cn("min-w-0 break-words", unread ? "font-semibold" : "font-medium")}>{item.title}</span>
          <time dateTime={item.createdAt} title={formatDateTime(item.createdAt)} className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {relativeTime(item.createdAt, now)}
          </time>
        </span>
        {item.body ? <span className={cn("break-words text-muted-foreground", codeBody ? "font-mono text-xs" : "text-xs")}>{item.body}</span> : null}
        {state ? <span className={cn("text-xs font-medium", state.waiting ? "text-signal-ink" : "text-muted-foreground")}>{state.text}</span> : null}
        {unread ? <span className="sr-only">, belum dibaca</span> : null}
      </span>
    </>
  );
  const className = "min-h-12 items-start gap-2.5 py-2";
  if (href) {
    return (
      <DropdownMenuItem asChild className={className} data-notification={item.id} data-unread={unread ? "1" : undefined} onSelect={() => onFollow(item)}>
        <Link href={href}>{content}</Link>
      </DropdownMenuItem>
    );
  }
  // leads nowhere: choosing it only marks it read, and the panel stays open
  return (
    <DropdownMenuItem
      className={className}
      data-notification={item.id}
      data-unread={unread ? "1" : undefined}
      onSelect={(event) => {
        event.preventDefault();
        onFollow(item);
      }}
    >
      {content}
    </DropdownMenuItem>
  );
}

/**
 * The bell of every signed-in account, with its inbox. An account that may open Keputusan sees the number of
 * requests waiting (a waiting request holds a truck) and a first line to Keputusan; every other account sees its
 * unread count. The count refreshes while the tab is visible and after each action in the panel; the list is
 * fetched when the panel opens. A failed count shows no number.
 */
export function NotificationsBell({ user }: { user: User }) {
  const approver = canSeeApprovals(user);
  const waiting = useApiQuery(
    approver ? "bell-exceptions" : null,
    (signal) => api.request<{ items: ExceptionView[] }>("/api/exceptions", { query: { status: "PENDING", limit: WAITING_LIMIT }, signal }),
    { keepPrevious: true },
  );
  const unreadCount = useApiQuery(
    approver ? null : "bell-unread",
    (signal) => api.request<NotificationPage>("/api/notifications", { query: { unread: "true", limit: 1 }, signal }),
    { keepPrevious: true },
  );
  useVisibleInterval(waiting.reload, WAITING_REFRESH_MS, approver);
  useVisibleInterval(unreadCount.reload, UNREAD_REFRESH_MS, !approver);

  const [open, setOpen] = useState(false);
  const [inbox, setInbox] = useState<Inbox>(EMPTY_INBOX);
  // the clock for "how long ago", set when the panel opens
  const [now, setNow] = useState(0);
  const listRequest = useRef<AbortController | null>(null);

  useEffect(() => () => listRequest.current?.abort(), []);

  const bell = bellNumber({ approver, waiting: waiting.data?.items.length, unread: unreadCount.data?.unreadCount });
  const badge = bellBadge(bell);

  function refreshCount() {
    if (approver) waiting.reload();
    else unreadCount.reload();
  }

  /** One page of the inbox, older than `before`; null when a newer request or closing the panel replaced it. */
  async function fetchPage(before: number | string | null): Promise<NotificationPage | null> {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    const query = { limit: PAGE_SIZE, ...(before === null ? {} : { before }) };
    try {
      const page = await api.request<NotificationPage>("/api/notifications", { query, signal: controller.signal });
      return controller.signal.aborted ? null : page;
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    }
  }

  async function loadFirst() {
    setInbox((current) => ({ ...current, status: "loading", more: "idle" }));
    try {
      const page = await fetchPage(null);
      if (!page) return;
      setInbox({ status: "ready", items: page.items, hasMore: page.items.length === PAGE_SIZE, more: "idle", unread: page.unreadCount });
    } catch {
      setInbox((current) => ({ ...current, status: "error" }));
    }
  }

  async function loadMore() {
    const last = inbox.items.at(-1);
    if (!last || inbox.more === "loading") return;
    setInbox((current) => ({ ...current, more: "loading" }));
    try {
      const page = await fetchPage(last.id);
      if (!page) return;
      setInbox((current) => ({
        ...current,
        items: appendPage(current.items, page.items),
        hasMore: page.items.length === PAGE_SIZE,
        more: "idle",
        unread: page.unreadCount,
      }));
    } catch {
      setInbox((current) => ({ ...current, more: "error" }));
    }
    refreshCount();
  }

  async function markRead(item: NotificationItem) {
    if (item.readAt !== null) return;
    try {
      const result = await api.request<NotificationRead>(`/api/notifications/${encodeURIComponent(String(item.id))}/read`, { method: "POST" });
      const readAt = result.notification?.readAt ?? new Date().toISOString();
      setInbox((current) => ({
        ...current,
        items: current.items.map((entry) => (String(entry.id) === String(item.id) ? { ...entry, readAt } : entry)),
        unread: result.unreadCount,
      }));
    } catch {
      // the entry stays unread; the next refresh shows the server's count
    }
    refreshCount();
  }

  async function markAllRead() {
    try {
      const result = await api.request<NotificationsReadAll>("/api/notifications/read-all", { method: "POST" });
      const readAt = new Date().toISOString();
      setInbox((current) => ({ ...current, items: current.items.map((entry) => (entry.readAt === null ? { ...entry, readAt } : entry)), unread: result.unreadCount }));
    } catch {
      // nothing changed on the server
    }
    refreshCount();
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setNow(Date.now());
      void loadFirst();
      refreshCount();
    } else {
      listRequest.current?.abort();
    }
  }

  const access = { canOpenDecisions: approver };
  const unreadInList = inbox.unread ?? 0;
  const waitingCount = bell.kind === "approvals" ? bell.count : null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="notifications-bell"
          data-mode={bell.kind}
          aria-label={bellLabel(bell)}
          className="relative flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted"
        >
          <Bell className="size-[1.125rem]" strokeWidth={1.75} aria-hidden="true" />
          {badge ? (
            <span
              aria-hidden="true"
              data-testid="bell-badge"
              className={cn(
                "absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-[0.6875rem] font-semibold ring-2 ring-background",
                bell.kind === "approvals" ? "bg-signal text-signal-foreground" : "bg-primary text-primary-foreground",
              )}
            >
              {badge}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        aria-label="Pemberitahuan"
        data-testid="notifications-panel"
        className="w-[min(24rem,calc(100vw-1rem))] max-h-[min(36rem,var(--radix-dropdown-menu-content-available-height))]"
      >
        <div className="flex items-center justify-between gap-2 pr-1">
          <DropdownMenuLabel className="flex min-w-0 flex-col px-2 py-1.5">
            <span className="text-sm font-semibold text-foreground">Pemberitahuan</span>
            <span className="text-xs font-normal text-muted-foreground">
              {inbox.unread === null ? " " : unreadInList > 0 ? `${unreadInList} belum dibaca` : "Semua sudah dibaca"}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={unreadInList === 0}
            className="min-h-9 shrink-0 px-2 text-xs font-medium text-link"
            onSelect={(event) => {
              event.preventDefault();
              void markAllRead();
            }}
          >
            Tandai semua dibaca
          </DropdownMenuItem>
        </div>

        {approver ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="min-h-11 gap-2.5 font-medium">
              <Link href="/keputusan" data-testid="bell-decisions">
                {waitingCount !== null && waitingCount > 0 ? (
                  <>
                    <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-signal px-1.5 font-mono text-xs font-semibold text-signal-foreground">
                      {badge}
                    </span>
                    <span className="min-w-0 flex-1">permintaan menunggu keputusan</span>
                  </>
                ) : (
                  <span className="min-w-0 flex-1">{waitingCount === 0 ? "Tidak ada yang menunggu keputusan" : "Buka Keputusan"}</span>
                )}
                <ArrowRight className="text-muted-foreground" aria-hidden="true" />
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}

        <DropdownMenuSeparator />
        {inbox.status === "error" && inbox.items.length === 0 ? (
          <>
            <p className="px-2 py-3 text-sm text-destructive">Pemberitahuan belum bisa dimuat.</p>
            <DropdownMenuItem
              className="min-h-10 justify-center font-medium text-link"
              onSelect={(event) => {
                event.preventDefault();
                void loadFirst();
              }}
            >
              Coba lagi
            </DropdownMenuItem>
          </>
        ) : inbox.items.length === 0 ? (
          <p className="flex items-center gap-2 px-2 py-4 text-sm text-muted-foreground" data-testid="notifications-empty">
            {inbox.status === "ready" ? (
              "Belum ada pemberitahuan."
            ) : (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Memuat
              </>
            )}
          </p>
        ) : (
          <div data-testid="notifications-list">
            {inbox.items.map((item) => (
              <Entry key={item.id} item={item} href={notificationTarget(item, access)} now={now} onFollow={(entry) => void markRead(entry)} />
            ))}
            {inbox.hasMore || inbox.more === "error" ? (
              <DropdownMenuItem
                className="min-h-10 justify-center font-medium text-link"
                disabled={inbox.more === "loading"}
                onSelect={(event) => {
                  event.preventDefault();
                  void loadMore();
                }}
              >
                {inbox.more === "loading" ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Memuat
                  </>
                ) : inbox.more === "error" ? (
                  "Belum bisa dimuat. Coba lagi"
                ) : (
                  "Muat lagi"
                )}
              </DropdownMenuItem>
            ) : null}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
