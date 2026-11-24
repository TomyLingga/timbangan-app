"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { ListError } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PlantMap } from "@/features/control-room/plant-map";
import { type LiveControlRoom, useNow, usePlanDrawing } from "@/features/control-room/use-control-room";
import { useZoneExplorer, ZoneExplorerLayer } from "@/features/control-room/zone-explorer";
import { formatClock, zoneCounts, zoneSummary } from "@/lib/control-room";
import { cn } from "@/lib/utils";

// Beranda for holders of the dashboard module: the live plant map of the control room with a truck picture and the
// count on each zone that holds trucks. A zone opens the list of its plates and a plate the truck detail window, as
// in the control room. The number of trucks per zone stands under the map in the zone colours.

export function HomePlant({ live }: { live: LiveControlRoom }) {
  const state = live.state;
  const plan = usePlanDrawing(state ? state.planImage ?? null : undefined);
  const now = useNow();
  const explorer = useZoneExplorer();
  const isLive = live.status === "live";

  return (
    <section aria-labelledby="denah-judul" className="rounded-3xl border bg-card p-3 shadow-panel sm:p-4" data-testid="home-plant">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="denah-judul" className="text-base font-semibold">
            Denah pabrik
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite" data-testid="home-live-status">
            <span aria-hidden="true" className={cn("size-2 rounded-full", isLive ? "bg-primary" : "bg-signal")} />
            {isLive ? "Live" : live.status === "polling" ? "Diperbarui tiap 5 detik" : "Menyambung…"}
            {live.receivedAt ? <span className="tabular-nums">· {formatClock(live.receivedAt)}</span> : null}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href="/ruang-kontrol">
            Buka ruang kontrol
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>

      {!state ? (
        live.error ? (
          <ListError title="Denah pabrik belum bisa dimuat" error={live.error} onRetry={() => window.location.reload()} />
        ) : (
          <Skeleton className="aspect-[916/506] w-full rounded-2xl" aria-label="Memuat denah pabrik" />
        )
      ) : (
        <>
          <p className="sr-only" aria-live="polite">
            {zoneSummary(state.zones, state.zoneStats, state.kpi.inside)}
          </p>
          <div className="site-grid rounded-2xl">
            <PlantMap state={state} plan={plan} now={now} onZone={explorer.toggleZone} openZone={explorer.openZone} />
          </div>
          <ul aria-label="Truk per zona" className="mt-3 flex flex-wrap gap-x-1.5 gap-y-1.5 px-1" data-testid="zone-counts">
            {zoneCounts(state.zones, state.zoneStats).map((zone) => (
              <li
                key={zone.code}
                className={cn("flex h-7 items-center gap-1.5 rounded-full border bg-surface pr-2.5 pl-2 text-xs", zone.count === 0 && "text-muted-foreground")}
              >
                <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-foreground/15" style={{ background: zone.color ?? "var(--muted)" }} />
                <span className="whitespace-nowrap">{zone.name}</span>
                <span className={cn("font-mono font-semibold tabular-nums", zone.count === 0 ? "text-faint" : "text-foreground")}>{zone.count}</span>
              </li>
            ))}
          </ul>
          <ZoneExplorerLayer explorer={explorer} state={state} now={now} />
        </>
      )}
    </section>
  );
}
