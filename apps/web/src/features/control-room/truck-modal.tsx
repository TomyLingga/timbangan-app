"use client";

import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { CircleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/hooks/use-api-query";
import { isApiError } from "@/lib/api-client";
import {
  type ControlRoomTruck,
  FLOW_LABELS,
  formatClock,
  formatWait,
  HELD_LABELS,
  isLongWait,
  minutesSince,
  type TripTimeline,
  type TruckFigures,
} from "@/lib/control-room";
import { formatNumber } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { api } from "@/lib/session";
import { cn } from "@/lib/utils";

// "Detail truk": one truck in a centred window, opened from a plate in a zone list. The plate and its state on top;
// the truck's papers; where it is now (from the live state); the letter and weighed figures side by side; the steps
// with times and durations; the weighings and the decision requests. The window traps the focus, and Escape gives it
// back to the plate it was opened from.

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

const TRIP_STATUS: Record<string, string> = {
  CHECKED_IN: "Sudah check-in",
  IN_PROCESS: "Di dalam pabrik",
  COMPLETED: "Selesai, sudah keluar",
  REJECTED: "Ditolak, sudah keluar",
  CANCELLED: "Dibatalkan",
};

const PLATE_CHECK: Record<string, string> = { MATCH: "plat cocok", CONFIRMED: "plat dikonfirmasi", BYPASSED: "plat dilewati" };

const kg = (value: number | null) => (value === null ? "-" : `${formatNumber(value)} kg`);

function stateText(live: ControlRoomTruck | null, timeline: TripTimeline | null): { text: string; tone: "held" | "normal" } {
  if (live?.held) return { text: HELD_LABELS[live.held.type] ?? "Ditahan", tone: "held" };
  if (live?.stepName) return { text: `${live.stepStatus === "IN_PROGRESS" ? "Sedang" : "Menunggu"} ${live.stepName.toLowerCase()}`, tone: "normal" };
  if (live) return { text: "Baru masuk", tone: "normal" };
  return { text: timeline ? (TRIP_STATUS[timeline.trip.status] ?? timeline.trip.status) : "", tone: "normal" };
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0", className)}>
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children ?? <span className="text-faint">-</span>}</dd>
    </div>
  );
}

function FiguresTable({ letter, weighed }: { letter: TruckFigures; weighed: TruckFigures }) {
  const rows: [string, keyof TruckFigures][] = [
    ["Bruto", "grossKg"],
    ["Tarra", "tareKg"],
    ["Netto", "netKg"],
  ];
  return (
    <table className="w-full text-sm" data-testid="truck-figures">
      <thead>
        <tr className="text-xs text-muted-foreground">
          <th className="pb-1 text-left font-medium" scope="col">
            <span className="sr-only">Angka</span>
          </th>
          <th className="pb-1 text-right font-medium" scope="col">
            Surat
          </th>
          <th className="pb-1 text-right font-medium" scope="col">
            Timbang
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map(([label, key]) => (
          <tr key={key}>
            <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
              {label}
            </th>
            <td className="py-1.5 text-right font-mono tabular-nums">{kg(letter[key])}</td>
            <td className="py-1.5 text-right font-mono font-semibold tabular-nums">{kg(weighed[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface TruckModalProps {
  tripId: number | null;
  /** The truck in the live state, for where it is now; null when it is no longer inside. */
  live: ControlRoomTruck | null;
  /** Short name of the live truck's zone. */
  zoneName: string | null;
  now: Date;
  onClose: () => void;
  /** Where the focus goes back to: the plate row, or the zone when the row is gone. */
  returnFocus: () => HTMLElement | null;
}

export function TruckModal({ tripId, live, zoneName, now, onClose, returnFocus }: TruckModalProps) {
  const query = useApiQuery<TripTimeline>(tripId === null ? null : `trip-${tripId}`, (signal) =>
    api.request<TripTimeline>(`/api/control-room/trips/${tripId}`, { signal }),
  );
  const timeline = query.data && query.data.trip.id === tripId ? query.data : null;
  const notFound = query.hasError && isApiError(query.error) && query.error.status === 404;
  const plate = timeline?.trip.plateDisplay ?? live?.plateDisplay ?? null;
  const state = stateText(live, timeline);

  return (
    <DialogPrimitive.Root open={tripId !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-[oklch(0.15_0.015_255/0.4)] backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 dark:bg-[oklch(0.05_0.01_255/0.65)]" />
        <DialogPrimitive.Content
          data-testid="truck-modal"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus()?.focus({ preventScroll: true });
          }}
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[min(92dvh,56rem)] w-[min(52rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-overlay data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97]"
        >
          <header className="flex items-start justify-between gap-4 border-b px-5 pt-4 pb-4 sm:px-6">
            <div className="min-w-0">
              <DialogPrimitive.Title className="kicker text-muted-foreground">Detail truk</DialogPrimitive.Title>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="plate text-2xl sm:text-[1.75rem]" data-testid="truck-modal-plate">
                  {plate ?? "Tanpa plat"}
                </span>
                {state.text ? (
                  <span
                    className={cn(
                      "inline-flex h-7 items-center rounded-full border px-3 text-sm font-medium",
                      state.tone === "held" ? "border-signal/50 bg-signal-subtle text-signal-ink" : "border-line-strong bg-surface",
                    )}
                  >
                    {state.text}
                  </span>
                ) : null}
              </div>
              {timeline ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {[FLOW_LABELS[timeline.trip.flowCode] ?? timeline.trip.flowCode, timeline.trip.checkedInAt ? `masuk ${formatClock(timeline.trip.checkedInAt)}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="-mr-2 shrink-0">
                <X aria-hidden="true" />
                <span className="sr-only">Tutup</span>
              </Button>
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
            {notFound ? (
              <p role="alert" className="rounded-xl border bg-surface p-4 text-sm">
                Data truk ini tidak ditemukan. Mungkin trip-nya sudah dihapus.
              </p>
            ) : query.hasError && !timeline ? (
              <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive-subtle p-4 text-sm text-destructive">
                <p className="flex items-center gap-2">
                  <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
                  {errorMessage(query.error)}
                </p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={query.reload}>
                  Coba lagi
                </Button>
              </div>
            ) : !timeline ? (
              <div className="grid gap-6 md:grid-cols-2" aria-label="Memuat detail truk" data-testid="truck-modal-loading">
                {Array.from({ length: 2 }, (_, column) => (
                  <div key={column} className="space-y-3">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-5 w-full" />
                    <Skeleton className="h-5 w-4/5" />
                    <Skeleton className="h-5 w-3/5" />
                  </div>
                ))}
              </div>
            ) : (
              <TruckDetail timeline={timeline} live={live} zoneName={zoneName} now={now} />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function TruckDetail({ timeline, live, zoneName, now }: { timeline: TripTimeline; live: ControlRoomTruck | null; zoneName: string | null; now: Date }) {
  const { truck } = timeline;
  const contracts = truck.allocations.map((row) => (row.doNo ? `${row.doNo} (${row.contractNo})` : row.contractNo));
  const minutes = live ? minutesSince(live.since, now) : null;
  return (
    <div className="grid gap-x-8 gap-y-6 md:grid-cols-2" data-testid="truck-detail">
      <Section title="Data truk">
        <dl className="divide-y">
          <Field label="Nomor trip">{timeline.trip.tripNo ? <span className="ident">{timeline.trip.tripNo}</span> : null}</Field>
          <Field label="Nomor SPJ">{truck.spjNo ? <span className="ident">{truck.spjNo}</span> : null}</Field>
          <Field label="Supir">{truck.driverName}</Field>
          <Field label="Transporter">{truck.transporterName}</Field>
          <Field label={truck.partnerRole === "SUPPLIER" ? "Pemasok" : "Customer"}>{truck.partnerName}</Field>
          <Field label="Barang">{truck.products.length ? truck.products.join(", ") : null}</Field>
          <Field label={timeline.trip.direction === "OUT" ? "DO (kontrak)" : "Kontrak"}>
            {contracts.length ? (
              <span className="flex flex-col">
                {contracts.map((text) => (
                  <span key={text} className="ident">
                    {text}
                  </span>
                ))}
              </span>
            ) : null}
          </Field>
          <Field label="Kartu">{truck.cardLabel ? <span className="ident">{truck.cardLabel}</span> : null}</Field>
          <Field label="Kendaraan">{[truck.vehicleType, truck.containerNo ? `kontainer ${truck.containerNo}` : null].filter(Boolean).join(", ") || null}</Field>
        </dl>
      </Section>

      <div className="flex min-w-0 flex-col gap-6">
        <Section title="Posisi sekarang">
          {live ? (
            <div className="rounded-xl border bg-surface px-4 py-3 text-sm" data-testid="truck-position">
              <p className="font-medium">{zoneName ?? live.zone}</p>
              <p className="mt-0.5 text-muted-foreground">{live.held ? (HELD_LABELS[live.held.type] ?? "Ditahan") : live.stepName ?? "Baru masuk, belum ada langkah berjalan"}</p>
              <p className={cn("mt-1 tabular-nums", minutes !== null && isLongWait(live.since, now) ? "font-medium text-warning" : "text-muted-foreground")}>
                Sejak {formatClock(live.since)}, {formatWait(minutes ?? 0)}
              </p>
            </div>
          ) : (
            <p className="rounded-xl border bg-surface px-4 py-3 text-sm text-muted-foreground">Truk ini sudah tidak di dalam pabrik.</p>
          )}
        </Section>
        <Section title="Angka surat dan hasil timbang">
          <FiguresTable letter={truck.letter} weighed={truck.weighed} />
        </Section>
      </div>

      <Section title="Langkah" className="md:col-span-1">
        <ol>
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
      </Section>

      <div className="flex min-w-0 flex-col gap-6">
        <Section title="Permintaan keputusan">
          {timeline.exceptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada.</p>
          ) : (
            <ul className="space-y-1.5 text-sm" data-testid="truck-exceptions">
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
        </Section>
        <Section title="Riwayat timbang">
          {timeline.weighings.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ditimbang.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
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
        </Section>
      </div>
    </div>
  );
}
