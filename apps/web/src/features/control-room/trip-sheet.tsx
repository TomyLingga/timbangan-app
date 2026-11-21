"use client";

import { CircleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/hooks/use-api-query";
import { FLOW_LABELS, formatClock, formatWait, HELD_LABELS, type TripTimeline } from "@/lib/control-room";
import { formatNumber } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { api } from "@/lib/session";
import { cn } from "@/lib/utils";

// The side sheet with one trip's timeline: its steps with times and durations, the weighings, and the decision
// requests. Opened from a marker or a plate in the zone panel.

const STEP_STATUS: Record<string, { label: string; dot: string }> = {
  DONE: { label: "Selesai", dot: "bg-success" },
  IN_PROGRESS: { label: "Dikerjakan", dot: "bg-info" },
  READY: { label: "Menunggu", dot: "bg-signal" },
  PENDING: { label: "Belum", dot: "bg-muted-foreground/40" },
  SKIPPED: { label: "Dilewati", dot: "bg-muted-foreground/40" },
  FAILED: { label: "Tidak lolos", dot: "bg-destructive" },
};

const EXCEPTION_STATUS: Record<string, string> = {
  PENDING: "Menunggu",
  APPROVED: "Disetujui",
  REJECTED: "Ditolak",
  RETRY: "Ulangi",
  CANCELLED: "Dibatalkan",
  EXPIRED: "Kedaluwarsa",
};

const PLATE_CHECK: Record<string, string> = { MATCH: "plat cocok", CONFIRMED: "plat dikonfirmasi", BYPASSED: "plat dilewati" };

export function TripSheet({ tripId, onClose }: { tripId: number | null; onClose: () => void }) {
  const query = useApiQuery<TripTimeline>(tripId === null ? null : `trip-${tripId}`, (signal) =>
    api.request<TripTimeline>(`/api/control-room/trips/${tripId}`, { signal }),
  );
  const timeline = query.data && query.data.trip.id === tripId ? query.data : null;

  return (
    <Sheet open={tripId !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md" data-testid="trip-sheet">
        <SheetHeader className="border-b px-5 pt-5 pb-4">
          <SheetTitle className="flex items-center gap-2.5">
            {timeline ? <span className="plate text-base">{timeline.trip.plateDisplay ?? "Tanpa plat"}</span> : "Garis waktu truk"}
          </SheetTitle>
          <SheetDescription>
            {timeline
              ? [FLOW_LABELS[timeline.trip.flowCode] ?? timeline.trip.flowCode, timeline.trip.tripNo, timeline.trip.checkedInAt ? `masuk ${formatClock(timeline.trip.checkedInAt)}` : null]
                  .filter(Boolean)
                  .join(" · ")
              : "Langkah, timbangan, dan permintaan keputusan."}
          </SheetDescription>
        </SheetHeader>

        <div className="px-5 py-4">
          {query.hasError && !timeline ? (
            <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive-subtle p-3 text-sm text-destructive">
              <p className="flex items-center gap-2">
                <CircleAlert className="size-4" aria-hidden="true" />
                {errorMessage(query.error)}
              </p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={query.reload}>
                Coba lagi
              </Button>
            </div>
          ) : !timeline ? (
            <div className="space-y-3" aria-label="Memuat garis waktu">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-3/5" />
            </div>
          ) : (
            <>
              <h3 className="text-xs font-semibold text-muted-foreground">Langkah</h3>
              <ol className="mt-2">
                {timeline.steps.map((step, index) => {
                  const status = STEP_STATUS[step.status] ?? { label: step.status, dot: "bg-muted-foreground/40" };
                  const last = index === timeline.steps.length - 1;
                  const time = step.finishedAt ?? step.startedAt ?? step.readyAt;
                  return (
                    <li key={`${step.code}-${index}`} className="relative flex gap-3 pb-3">
                      {!last ? <span aria-hidden="true" className="absolute top-3 left-[5px] h-full w-px bg-border" /> : null}
                      <span aria-hidden="true" className={cn("relative mt-1.5 size-[11px] shrink-0 rounded-full ring-2 ring-popover", status.dot)} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-baseline justify-between gap-3 text-sm">
                          <span className={cn("font-medium", (step.status === "PENDING" || step.status === "SKIPPED") && "text-muted-foreground")}>{step.name ?? step.code}</span>
                          {time ? <time className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{formatClock(time)}</time> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {status.label}
                          {step.minutes !== null && step.status !== "PENDING" && step.status !== "SKIPPED" ? `, ${formatWait(step.minutes)}` : ""}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>

              <h3 className="mt-4 text-xs font-semibold text-muted-foreground">Timbangan</h3>
              {timeline.weighings.length === 0 ? (
                <p className="mt-1.5 text-sm text-muted-foreground">Belum ditimbang.</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5 text-sm">
                  {timeline.weighings.map((weighing, index) => (
                    <li key={index} className={cn("flex items-baseline justify-between gap-3", weighing.status === "VOID" && "text-muted-foreground line-through")}>
                      <span>
                        Timbang {weighing.stage} ({weighing.kind === "GROSS" ? "bruto" : "tarra"}), {PLATE_CHECK[weighing.plateCheck] ?? weighing.plateCheck}
                        {weighing.mode === "EXCEPTION" ? ", lewat keputusan" : ""}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums">
                        {formatNumber(weighing.kg)} kg <span className="text-xs text-muted-foreground">{formatClock(weighing.at)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="mt-4 text-xs font-semibold text-muted-foreground">Permintaan keputusan</h3>
              {timeline.exceptions.length === 0 ? (
                <p className="mt-1.5 text-sm text-muted-foreground">Tidak ada.</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5 text-sm">
                  {timeline.exceptions.map((item, index) => (
                    <li key={index} className="flex items-baseline justify-between gap-3">
                      <span className={cn(item.status === "PENDING" && "font-medium text-signal-ink")}>
                        {HELD_LABELS[item.type]?.replace(/^Menunggu keputusan /, "Selisih ") ?? item.type}: {EXCEPTION_STATUS[item.status] ?? item.status}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {formatClock(item.raisedAt)}
                        {item.decidedAt ? `–${formatClock(item.decidedAt)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
