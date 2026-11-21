"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { Maximize2 } from "lucide-react";

import { AccessDenied, ListError } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-provider";
import { PlantMap } from "@/features/control-room/plant-map";
import { KpiStrip, RecentEvents, ZonePanel } from "@/features/control-room/panels";
import { TripSheet } from "@/features/control-room/trip-sheet";
import { useLiveControlRoom, useNow, usePlanDrawing } from "@/features/control-room/use-control-room";
import { formatClock, LONG_WAIT_MINUTES, zoneSummary } from "@/lib/control-room";
import type { FeedStatus } from "@/lib/control-room-stream";
import { cn } from "@/lib/utils";

// /ruang-kontrol: the control room. KPI strip on top, the live plant map in the middle, zones and the latest
// changes beside it. `?layar=tv` is the wall-screen mode: its own full-screen frame over the app shell, larger type,
// no pointer interaction, and the cursor hidden after a few idle seconds.

const subscribeNever = () => () => {};
const readTvMode = () => new URLSearchParams(window.location.search).get("layar") === "tv";

const CURSOR_IDLE_MS = 3_000;

function LiveBadge({ status, receivedAt, tv }: { status: FeedStatus; receivedAt: Date | null; tv: boolean }) {
  const live = status === "live";
  const label = live ? "Live" : status === "polling" ? "Cadangan: diperbarui tiap 5 detik" : status === "connecting" ? "Menyambung…" : "Menyambung ulang…";
  return (
    <p className={cn("flex items-center gap-2.5", tv ? "text-base" : "text-sm")} aria-live="polite" data-testid="live-status">
      <span
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 font-medium",
          live ? "border-primary/30 bg-primary-subtle text-primary-ink" : "border-signal/40 bg-signal-subtle text-signal-ink",
        )}
      >
        <span aria-hidden="true" className={cn("size-2 rounded-full", live ? "bg-primary motion-safe:animate-pulse" : "bg-signal")} />
        {label}
      </span>
      {receivedAt ? <span className="text-muted-foreground tabular-nums">Diperbarui {formatClock(receivedAt, true)}</span> : null}
    </p>
  );
}

function Legend({ tv }: { tv: boolean }) {
  const item = (swatch: ReactNode, text: string) => (
    <li className="flex items-center gap-1.5">
      {swatch}
      {text}
    </li>
  );
  return (
    <ul aria-hidden="true" className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground", tv ? "text-sm" : "text-xs")}>
      {item(<span className="h-2.5 w-5 rounded-full bg-stream-in" />, "Incoming")}
      {item(<span className="h-2.5 w-5 rounded-full bg-stream-out" />, "Outgoing")}
      {item(<span className="h-2.5 w-5 rounded-full ring-2 ring-signal" />, "Menunggu keputusan")}
      {item(<span className="h-2.5 w-5 rounded-full ring-1 ring-warning" style={{ background: "color-mix(in oklch, var(--stream-in) 62%, var(--warning))" }} />, `Lebih dari ${LONG_WAIT_MINUTES} menit di satu zona`)}
    </ul>
  );
}

function LoadingLayout() {
  return (
    <div className="space-y-4" aria-label="Memuat ruang kontrol">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="aspect-[16/9] w-full rounded-3xl" />
    </div>
  );
}

export function ControlRoomScreen() {
  const { state: auth } = useAuth();
  const user = auth.status === "authenticated" ? auth.user : null;
  const allowed = !!user && user.kind === "INTERNAL" && !!user.permissions.dashboard;
  if (!allowed) {
    return (
      <AccessDenied
        module="dashboard"
        reason="Ruang kontrol bagian dari modul Dashboard untuk akun karyawan. Minta admin sistem memberi Anda hak lihat modul itu."
      />
    );
  }
  return <ControlRoom />;
}

function ControlRoom() {
  const tv = useSyncExternalStore(subscribeNever, readTvMode, () => false);
  const live = useLiveControlRoom();
  const plan = usePlanDrawing();
  const now = useNow();
  const [selected, setSelected] = useState<number | null>(null);
  const [cursorHidden, setCursorHidden] = useState(false);

  // TV: larger type everywhere (the page's sizes are in rem), and the cursor hides after a few idle seconds
  useEffect(() => {
    if (!tv) return;
    const root = document.documentElement;
    const before = root.style.fontSize;
    root.style.fontSize = "125%";
    let timer = setTimeout(() => setCursorHidden(true), CURSOR_IDLE_MS);
    const wake = () => {
      setCursorHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorHidden(true), CURSOR_IDLE_MS);
    };
    window.addEventListener("pointermove", wake);
    return () => {
      root.style.fontSize = before;
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
    };
  }, [tv]);

  const state = live.state;
  const summary = state ? zoneSummary(state.zones, state.zoneStats, state.kpi.inside) : "";

  const body = !state ? (
    live.error ? (
      <ListError title="Ruang kontrol belum bisa dimuat" error={live.error} onRetry={() => window.location.reload()} />
    ) : (
      <LoadingLayout />
    )
  ) : (
    <div className={cn("flex min-h-0 flex-col gap-4", tv && "h-full")}>
      <KpiStrip state={state} tv={tv} />
      <p className="sr-only" aria-live="polite">
        {summary}
      </p>
      <div className={cn("grid min-h-0 gap-4", tv ? "flex-1 grid-cols-[minmax(0,1fr)_30rem]" : "lg:grid-cols-[minmax(0,1fr)_19rem]")}>
        <section aria-label="Denah pabrik" className={cn("min-w-0 rounded-3xl border bg-card p-3 shadow-panel sm:p-4", tv && "flex min-h-0 flex-col justify-center")}>
          <div className="site-grid rounded-2xl">
            <PlantMap state={state} plan={plan} now={now} tv={tv} onSelect={tv ? undefined : setSelected} />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Legend tv={tv} />
            {!plan.markup && plan.loaded ? <p className="text-xs text-muted-foreground">Gambar denah belum tersedia; zona tetap ditampilkan.</p> : null}
          </div>
        </section>
        <div className={cn("flex min-w-0 flex-col gap-4", tv && "min-h-0")}>
          <ZonePanel state={state} tv={tv} onSelect={tv ? undefined : setSelected} />
          <RecentEvents state={state} tv={tv} limit={tv ? 6 : undefined} />
        </div>
      </div>
    </div>
  );

  if (tv) {
    return (
      <div
        className={cn("fixed inset-0 z-[60] flex flex-col gap-4 overflow-hidden bg-background p-5", cursorHidden && "cursor-none [&_*]:cursor-none")}
        data-testid="control-room-tv"
      >
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="kicker text-muted-foreground">Ruang kontrol</p>
            <h1 className="display text-2xl font-semibold">Aktivitas truk di pabrik</h1>
          </div>
          <div className="flex items-center gap-6">
            <LiveBadge status={live.status} receivedAt={live.receivedAt} tv />
            <p className="display text-3xl font-semibold tabular-nums" aria-label="Jam">
              {formatClock(now)}
            </p>
          </div>
        </header>
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="control-room">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <p className="kicker text-muted-foreground">Pemantauan</p>
          <h1 className="mt-1 text-2xl font-semibold">Ruang kontrol</h1>
          <p className="mt-1 text-sm text-muted-foreground">Posisi truk di pabrik menurut langkahnya, diperbarui begitu langkah berubah.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <LiveBadge status={live.status} receivedAt={live.receivedAt} tv={false} />
          <Button asChild variant="secondary" size="sm">
            <Link href="/ruang-kontrol?layar=tv" target="_blank" rel="noopener">
              <Maximize2 aria-hidden="true" />
              Layar TV
            </Link>
          </Button>
        </div>
      </div>
      {body}
      <TripSheet tripId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

