"use client";

import Link from "next/link";
import { Bell } from "lucide-react";

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
import { api } from "@/lib/session";
import type { ExceptionView } from "@/lib/types";
import { exceptionTypeLabel, waitedFor } from "@/lib/weighing";
import { cn } from "@/lib/utils";

const REFRESH_MS = 15_000;
const LIMIT = 50;
const SHOWN = 5;

/**
 * The number of requests waiting for a decision, refreshed every 15 seconds
 * while the tab is visible, with a short list that leads to Keputusan. No sound.
 * Only for holders of `approvals` (the caller checks).
 */
export function ApprovalsBell() {
  const pending = useApiQuery("bell-exceptions", (signal) =>
    api.request<{ items: ExceptionView[] }>("/api/exceptions", { query: { status: "PENDING", limit: LIMIT }, signal }),
  { keepPrevious: true });
  useVisibleInterval(pending.reload, REFRESH_MS);

  const items = pending.data?.items ?? [];
  const count = items.length;
  const countText = count >= LIMIT ? `${LIMIT}+` : String(count);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="approvals-bell"
          aria-label={pending.data ? `Permintaan keputusan, ${countText} menunggu` : "Permintaan keputusan"}
          className="relative flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted"
        >
          <Bell className="size-[1.125rem]" strokeWidth={1.75} aria-hidden="true" />
          {count > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-signal px-1 font-mono text-[0.6875rem] font-semibold text-signal-foreground ring-2 ring-background"
            >
              {countText}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-baseline justify-between px-2 py-2">
          <span className="text-sm font-semibold text-foreground">Menunggu keputusan</span>
          <span className="font-mono text-xs text-muted-foreground">{pending.data ? countText : "…"}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {pending.hasError && !pending.data ? (
          <p className="px-2 py-3 text-sm text-destructive">Daftar belum bisa dimuat.</p>
        ) : count === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">{pending.data ? "Tidak ada yang menunggu." : "Memuat"}</p>
        ) : (
          items.slice(0, SHOWN).map((item) => (
            <DropdownMenuItem key={item.id} asChild className="min-h-12 items-start">
              <Link href="/keputusan" className="flex flex-col gap-0.5">
                <span className="flex w-full items-baseline justify-between gap-3">
                  <span className="font-medium">{exceptionTypeLabel(item.type)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{waitedFor(item.raisedAt)}</span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">{item.trip.plateDisplay ?? item.plateNo ?? "-"}</span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className={cn("min-h-10 justify-center font-medium text-link")}>
          <Link href="/keputusan">Buka Keputusan</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
