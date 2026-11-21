"use client";

import type { ReactNode } from "react";

import {
  type ControlRoomState,
  formatClock,
  formatWait,
  LONG_WAIT_MINUTES,
  shortZoneName,
} from "@/lib/control-room";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// The figures above the map and the panel beside it: trucks per zone with the longest wait, and the latest step
// changes of the day.

function Figure({ label, value, detail, tone, tv }: { label: string; value: ReactNode; detail?: ReactNode; tone?: "signal"; tv: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-2xl border bg-card px-4 py-3 shadow-panel", tone === "signal" && "border-signal/50 bg-signal-subtle")}>
      <p className={cn("truncate text-muted-foreground", tv ? "text-sm" : "text-xs")}>{label}</p>
      <p className={cn("display mt-1 leading-none font-semibold", tv ? "text-4xl" : "text-2xl", tone === "signal" && "text-signal-ink")}>{value}</p>
      {detail ? <p className={cn("mt-1.5 truncate text-muted-foreground", tv ? "text-sm" : "text-xs")}>{detail}</p> : null}
    </div>
  );
}

export function KpiStrip({ state, tv = false }: { state: ControlRoomState; tv?: boolean }) {
  const { kpi, upcoming } = state;
  return (
    <section aria-label="Angka hari ini" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      <Figure tv={tv} label="Di dalam pabrik" value={formatNumber(kpi.inside)} detail={`${state.trucks.filter((truck) => truck.direction === "IN").length} incoming, ${state.trucks.filter((truck) => truck.direction === "OUT").length} outgoing`} />
      <Figure tv={tv} label="Akan datang hari ini" value={formatNumber(kpi.upcoming)} detail={`${upcoming.in} incoming, ${upcoming.out} outgoing`} />
      <Figure
        tv={tv}
        label="Menunggu keputusan"
        value={formatNumber(kpi.pendingDecisions)}
        tone={kpi.pendingDecisions > 0 ? "signal" : undefined}
        detail={kpi.pendingDecisions > 0 ? "Selisih timbang atau QC" : "Tidak ada"}
      />
      <Figure tv={tv} label="Selesai hari ini" value={formatNumber(kpi.finishedToday)} detail="Sudah keluar" />
      <Figure
        tv={tv}
        label="Rata-rata di pabrik"
        value={kpi.avgMinutesInPlantToday === null ? "-" : formatWait(Math.round(kpi.avgMinutesInPlantToday))}
        detail="Truk yang selesai hari ini"
      />
    </section>
  );
}

export function ZonePanel({ state, tv = false, onSelect }: { state: ControlRoomState; tv?: boolean; onSelect?: (tripId: number) => void }) {
  const stats = new Map(state.zoneStats.map((stat) => [stat.zone, stat]));
  return (
    <section aria-labelledby="zona-judul" className="shrink-0 rounded-3xl border bg-card p-4 shadow-panel">
      <h2 id="zona-judul" className={cn("font-semibold", tv ? "text-lg" : "text-sm")}>
        Zona
      </h2>
      <ul className={cn("mt-2", tv ? "grid grid-cols-2 gap-x-5" : "divide-y")}>
        {state.zones.map((zone) => {
          const stat = stats.get(zone.code);
          const count = stat?.count ?? 0;
          const longest = stat?.longest ?? null;
          const trucks = state.trucks.filter((truck) => truck.zone === zone.code);
          const long = longest !== null && longest.minutes >= LONG_WAIT_MINUTES;
          return (
            <li key={zone.code} className={cn("flex items-start gap-3", tv ? "py-1.5" : "py-2")}>
              <span aria-hidden="true" className="mt-1 size-3 shrink-0 rounded-[3px] ring-1 ring-foreground/15" style={{ background: zone.color ?? "var(--muted)" }} />
              <div className="min-w-0 flex-1">
                <p className={cn("flex items-baseline justify-between gap-2", tv ? "text-base" : "text-sm")}>
                  <span className="truncate font-medium">{shortZoneName(zone)}</span>
                  <span className={cn("font-mono font-semibold tabular-nums", count === 0 && "text-faint")}>{count}</span>
                </p>
                {longest ? (
                  <p className={cn("mt-0.5 truncate", tv ? "text-sm" : "text-xs", long ? "text-warning" : "text-muted-foreground")}>
                    Terlama {longest.plateDisplay ?? "-"}, {formatWait(longest.minutes)}
                  </p>
                ) : null}
                {!tv && trucks.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {trucks.slice(0, 6).map((truck) => (
                      <button
                        key={truck.tripId}
                        type="button"
                        onClick={onSelect ? () => onSelect(truck.tripId) : undefined}
                        className="plate cursor-pointer text-[0.6875rem] transition-colors hover:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                        aria-label={`${truck.plateDisplay ?? "Truk"}: buka garis waktu`}
                      >
                        {truck.plateDisplay ?? "?"}
                      </button>
                    ))}
                    {trucks.length > 6 ? <span className="self-center text-xs text-muted-foreground">+{trucks.length - 6}</span> : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RecentEvents({ state, tv = false, limit }: { state: ControlRoomState; tv?: boolean; limit?: number }) {
  const items = limit ? state.recent.slice(0, limit) : state.recent;
  return (
    <section aria-labelledby="kejadian-judul" className={cn("flex min-h-0 flex-col rounded-3xl border bg-card p-4 shadow-panel", tv && "flex-1 overflow-hidden")}>
      <h2 id="kejadian-judul" className={cn("font-semibold", tv ? "text-lg" : "text-sm")}>
        Kejadian terakhir
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Belum ada perpindahan langkah hari ini.</p>
      ) : (
        <ol className={cn("mt-2 min-h-0 space-y-1.5 pr-1", tv ? "overflow-hidden text-base" : "max-h-96 overflow-y-auto text-sm")}>
          {items.map((item) => (
            <li key={`${item.at}-${item.tripId}-${item.text}`} className="flex gap-2.5">
              <time dateTime={item.at} className="w-11 shrink-0 font-mono text-muted-foreground tabular-nums">
                {formatClock(item.at)}
              </time>
              <span className="min-w-0">{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
