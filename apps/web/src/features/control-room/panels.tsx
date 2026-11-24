"use client";

import type { ReactNode } from "react";

import { type ControlRoomState, formatClock, formatWait } from "@/lib/control-room";
import { groupTrucksByZone, zoneLabel } from "@/lib/control-room-map";
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

/** Plates shown per zone on the wall screen before the rest is counted. */
const TV_PLATES = 4;

/**
 * Trucks per zone with the one that has waited longest. A row of a zone with trucks opens its plate list; the wall
 * screen, which cannot be clicked, lists the plates in the row instead.
 */
export function ZonePanel({
  state,
  now,
  tv = false,
  onZone,
  openZone = null,
}: {
  state: ControlRoomState;
  now: Date;
  tv?: boolean;
  onZone?: (code: string, anchor: HTMLElement) => void;
  openZone?: string | null;
}) {
  const groups = groupTrucksByZone(state.zones, state.trucks, now);
  return (
    <section aria-labelledby="zona-judul" className="shrink-0 rounded-3xl border bg-card p-4 shadow-panel" data-testid="zone-panel">
      <h2 id="zona-judul" className={cn("font-semibold", tv ? "text-lg" : "text-sm")}>
        Zona
      </h2>
      <ul className={cn("mt-2", tv ? "grid grid-cols-2 gap-x-5" : "-mx-2")}>
        {groups.map((group) => {
          const longest = group.longest;
          const body = (
            <>
              <span aria-hidden="true" className="mt-1 size-3 shrink-0 rounded-[3px] ring-1 ring-foreground/15" style={{ background: group.color ?? "var(--muted)" }} />
              <span className="min-w-0 flex-1">
                <span className={cn("flex items-baseline justify-between gap-2", tv ? "text-base" : "text-sm")}>
                  <span className="truncate font-medium">{group.name}</span>
                  <span className={cn("flex items-center gap-1.5 font-mono font-semibold tabular-nums", group.count === 0 && "text-faint")}>
                    {group.held ? <span aria-hidden="true" className="size-2 rounded-full bg-signal" /> : null}
                    {group.count}
                  </span>
                </span>
                {longest ? (
                  <span className={cn("mt-0.5 block truncate", tv ? "text-sm" : "text-xs", longest.long ? "text-warning" : "text-muted-foreground")}>
                    Terlama {longest.truck.plateDisplay ?? "-"}, {formatWait(longest.minutes)}
                  </span>
                ) : null}
                {tv && group.count > 0 ? (
                  <span className="mt-1.5 flex flex-wrap gap-1" data-testid="tv-zone-plates">
                    {group.trucks.slice(0, TV_PLATES).map((row) => (
                      <span key={row.truck.tripId} className={cn("plate text-xs", row.held && "border-signal text-signal-ink")}>
                        {row.truck.plateDisplay ?? "?"}
                      </span>
                    ))}
                    {group.count > TV_PLATES ? <span className="self-center text-sm text-muted-foreground">+{group.count - TV_PLATES}</span> : null}
                  </span>
                ) : null}
              </span>
            </>
          );
          if (tv || !onZone || group.count === 0) {
            return (
              <li key={group.code} className={cn("flex items-start gap-3", tv ? "py-1.5" : "px-2 py-2")}>
                {body}
              </li>
            );
          }
          return (
            <li key={group.code}>
              <button
                type="button"
                data-zone-row={group.code}
                aria-haspopup="dialog"
                aria-expanded={openZone === group.code}
                aria-label={`${zoneLabel(group)}. Buka daftar plat.`}
                onClick={(event) => onZone(group.code, event.currentTarget)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                  openZone === group.code && "bg-muted",
                )}
              >
                {body}
              </button>
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
