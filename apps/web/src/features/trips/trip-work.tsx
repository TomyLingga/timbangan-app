"use client";

import { useState } from "react";
import { CircleAlert, Loader2, RefreshCw } from "lucide-react";

import { TextAreaField, TextField } from "@/components/form-fields";
import { Notice } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDateTime, formatNumber } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { canCompleteStep } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { TripStep, TripWork, User } from "@/lib/types";
import { plateCheckLabel, stepStatusInfo, weighingLabel, weighingModeLabel } from "@/lib/weighing";
import { cn } from "@/lib/utils";

const kg = (value: number | null) => (value === null ? "-" : `${formatNumber(value)} kg`);

/** The steps, the weighings and the split of one truck, from GET /api/trips/:id/steps (staff accounts). */
export function TripWorkPanel({ tripId, user, onChanged }: { tripId: string | number; user: User; onChanged?: () => void }) {
  const [token, setToken] = useState(0);
  const work = useApiQuery(`trip-work|${tripId}|${token}`, (signal) =>
    api.request<TripWork>(`/api/trips/${encodeURIComponent(String(tripId))}/steps`, { signal }),
  { keepPrevious: true });

  if (work.hasError) {
    return (
      <div className="flex flex-col items-start gap-2 py-2 text-sm">
        <p role="alert" className="flex items-start gap-2 text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {errorMessage(work.error)}
        </p>
        <Button variant="outline" size="sm" onClick={work.reload}>
          <RefreshCw aria-hidden="true" />
          Coba lagi
        </Button>
      </div>
    );
  }
  if (!work.data) {
    return (
      <div className="flex flex-col gap-2 py-2" aria-busy="true">
        <span className="sr-only" role="status">
          Memuat langkah truk
        </span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }

  const { trip, steps, weighings } = work.data;
  const ready = steps.find((step) => step.status === "READY" || step.status === "IN_PROGRESS") ?? null;
  const split = trip.allocations.length > 1;

  return (
    <div className={cn("flex flex-col gap-5", work.isStale && "opacity-60")} data-testid="trip-work">
      <section aria-label="Langkah truk">
        <h4 className="text-sm font-semibold">Langkah</h4>
        {steps.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Langkah dibuat saat truk check-in di pos.</p>
        ) : (
          <ol className="mt-2 flex flex-col">
            {steps.map((step) => (
              <StepRow key={`${step.stepCode}-${step.attempt}`} step={step} />
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Hasil timbang">
        <h4 className="text-sm font-semibold">Timbang</h4>
        {weighings.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Belum ditimbang.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y rounded-xl border">
            {weighings.map((weighing) => (
              <li key={weighing.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2.5 text-sm">
                <span className="font-medium">{weighingLabel(weighing.stage, weighing.kind)}</span>
                <span className="font-mono text-base font-semibold">{kg(weighing.weightKg)}</span>
                <span className="w-full text-xs text-muted-foreground">
                  {formatDateTime(weighing.weighedAt)}, {weighingModeLabel(weighing.mode).toLowerCase()}, {plateCheckLabel(weighing.plateCheck).toLowerCase()}
                  {weighing.plateRead ? ` (kamera: ${weighing.plateRead})` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
          {[
            ["Bruto", trip.grossKg],
            ["Tarra", trip.tareKg],
            ["Netto", trip.netKg],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-xl border bg-surface px-3 py-2">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-mono font-semibold">{kg(value as number | null)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {split ? (
        <section aria-label="Pembagian netto">
          <h4 className="text-sm font-semibold">Pembagian netto</h4>
          <ul className="mt-2 flex flex-col divide-y rounded-xl border">
            {trip.allocations.map((share) => (
              <li key={share.seq} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2.5 text-sm">
                <span className="ident min-w-0 wrap-break-word">{share.doNo ?? share.contractNo}</span>
                <span className="font-mono font-semibold">{kg(share.netKg)}</span>
                {share.uom !== "kg" && share.qtyActual !== null ? (
                  <span className="w-full text-xs text-muted-foreground">
                    Realisasi {formatNumber(share.qtyActual)} {share.uom}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ready && canCompleteStep(user, ready.performerModule) && !["WEIGH_1", "WEIGH_2", "CHECK_OUT"].includes(ready.stepCode) ? (
        <TemporaryStepForm
          tripId={tripId}
          step={ready}
          work={work.data}
          onDone={() => {
            setToken((value) => value + 1);
            onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

function StepRow({ step }: { step: TripStep }) {
  const info = stepStatusInfo(step.status);
  const time = step.finishedAt ?? (step.status === "READY" || step.status === "IN_PROGRESS" ? step.readyAt : null);
  return (
    <li className="relative flex gap-3 pb-3 last:pb-0" data-step={step.stepCode}>
      <span
        aria-hidden="true"
        className={cn(
          "relative z-10 mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-card",
          step.status === "DONE" ? "bg-primary" : step.status === "FAILED" ? "bg-destructive" : step.status === "READY" || step.status === "IN_PROGRESS" ? "bg-signal" : "bg-line-strong",
        )}
      />
      <span aria-hidden="true" className="absolute top-3 bottom-0 left-[4.5px] w-px bg-border [li:last-child>&]:hidden" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={cn("text-sm", step.status === "PENDING" || step.status === "SKIPPED" ? "text-muted-foreground" : "font-medium")}>{step.name}</span>
        <span className="flex items-center gap-2">
          {time ? <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(time)}</span> : null}
          <StatusBadge info={info} />
        </span>
        {step.note ? <span className="w-full text-xs text-muted-foreground">Catatan: {step.note}</span> : null}
      </div>
    </li>
  );
}

// TEMPORARY until the phone app of phase 5: completes a field step from the web
// (POST /api/trips/:id/steps/:stepCode/complete). Remove this block and its use
// above when the field forms exist.
function TemporaryStepForm({ tripId, step, work, onDone }: { tripId: string | number; step: TripStep; work: TripWork; onDone: () => void }) {
  const counted = work.trip.allocations.filter((share) => share.uom !== "kg");
  const [note, setNote] = useState("");
  const [qty, setQty] = useState<Record<number, string>>({});
  const [pending, setPending] = useState<"PASS" | "FAIL" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function complete(result: "PASS" | "FAIL") {
    if (pending) return;
    setPending(result);
    setFailure(null);
    const qtyActual = counted
      .filter((share) => qty[share.seq]?.trim())
      .map((share) => ({ seq: share.seq, qty: Number(qty[share.seq]?.replace(/\./g, "").replace(",", ".")) }));
    try {
      await api.request(`/api/trips/${encodeURIComponent(String(tripId))}/steps/${encodeURIComponent(step.stepCode)}/complete`, {
        method: "POST",
        body: { result, ...(note.trim() ? { note: note.trim() } : {}), ...(qtyActual.length ? { qtyActual } : {}) },
      });
      setNote("");
      onDone();
    } catch (error) {
      setFailure(errorMessage(error));
    }
    setPending(null);
  }

  return (
    <section aria-label="Selesaikan langkah" className="rounded-2xl border border-dashed border-signal/60 bg-signal-subtle/40 p-4" data-testid="temporary-step">
      <p className="text-sm font-semibold">Selesaikan langkah: {step.name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">Sementara, sampai aplikasi petugas lapangan tersedia.</p>
      <div className="mt-3 flex flex-col gap-3">
        {counted.map((share) => (
          <TextField
            key={share.seq}
            label={`Jumlah ${share.doNo ?? share.contractNo} (${share.uom})`}
            name={`qty-${share.seq}`}
            inputMode="decimal"
            value={qty[share.seq] ?? ""}
            onChange={(value) => setQty((current) => ({ ...current, [share.seq]: value }))}
            optional
          />
        ))}
        <TextAreaField label="Catatan" name="stepNote" value={note} onChange={setNote} optional rows={2} />
        <div aria-live="polite">{failure ? <Notice tone="error">{failure}</Notice> : null}</div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void complete("PASS")} disabled={pending !== null}>
            {pending === "PASS" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Selesai
          </Button>
          <Button variant="destructive" onClick={() => void complete("FAIL")} disabled={pending !== null}>
            {pending === "FAIL" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Tolak truk
          </Button>
        </div>
      </div>
    </section>
  );
}
