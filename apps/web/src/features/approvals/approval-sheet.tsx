"use client";

import { useState } from "react";
import { CircleAlert, Loader2, RefreshCw } from "lucide-react";

import { CheckboxField, TextAreaField } from "@/components/form-fields";
import { Notice } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { DifferenceFigure, PlateComparison } from "@/features/approvals/exception-figures";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDateTime, formatNumber } from "@/lib/format";
import { isApiError } from "@/lib/api-client";
import { decisionErrorMessage, errorMessage } from "@/lib/messages";
import { canDecide } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { ExceptionView, User } from "@/lib/types";
import { decisionLabel, exceptionStatusInfo, exceptionTypeLabel, needsReason, referenceLabel, waitedFor } from "@/lib/weighing";

type Decision = "APPROVE" | "REJECT" | "OK" | "ADD_LOAD" | "REDUCE_LOAD";

const CHOICES: Record<"default" | "NET_OUT", ReadonlyArray<{ value: Decision; label: string; variant: "default" | "outline" | "destructive" }>> = {
  default: [
    { value: "APPROVE", label: "Setujui", variant: "default" },
    { value: "REJECT", label: "Tolak", variant: "destructive" },
  ],
  NET_OUT: [
    { value: "OK", label: "Sesuai", variant: "default" },
    { value: "ADD_LOAD", label: "Tambah muatan", variant: "outline" },
    { value: "REDUCE_LOAD", label: "Kurangi muatan", variant: "outline" },
  ],
};

/** What each decision does, in the words of the decision table (docs/fase-4-rancangan.md, section 2). */
function consequence(type: string): string {
  switch (type) {
    case "PLATE":
      return "Setujui: timbang dilanjutkan dengan plat registrasi. Tolak: timbang tidak tersimpan dan supir diarahkan ke pos registrasi.";
    case "NET_OUT":
      return "Sesuai: timbang 2 tersimpan. Tambah atau kurangi muatan: timbang tidak tersimpan, muat, segel, dan timbang 2 diulang.";
    default:
      return "Setujui: timbang tersimpan dan Berita Acara bernomor dibuat. Tolak: timbang tidak tersimpan.";
  }
}

const kg = (value: number | null) => (value === null ? "-" : `${formatNumber(value)} kg`);

export function ApprovalSheet({ id, user, onClose, onDecided }: { id: string | number; user: User; onClose: () => void; onDecided: () => void }) {
  const detail = useApiQuery(`exception|${id}`, (signal) => api.request<{ exception: ExceptionView }>(`/api/exceptions/${encodeURIComponent(String(id))}`, { signal }), {
    keepPrevious: true,
  });
  const view = detail.data?.exception;
  // the server's refusal stays in view after the detail reloads and the form is gone
  const [refusal, setRefusal] = useState<string | null>(null);
  const title = view ? `${exceptionTypeLabel(view.type)} ${view.trip.plateDisplay ?? view.plateNo ?? ""}`.trim() : "Permintaan keputusan";

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader className="border-b px-4 py-4 pr-14 sm:px-5">
          <SheetTitle className="text-base font-semibold">{title}</SheetTitle>
          <SheetDescription>{view ? `Diminta ${formatDateTime(view.raisedAt)}` : "Memuat rincian"}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 sm:px-5">
          {detail.hasError && !view ? (
            <div className="flex flex-col items-start gap-2 text-sm">
              <p role="alert" className="flex items-start gap-2 text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {errorMessage(detail.error)}
              </p>
              <Button variant="outline" size="sm" onClick={detail.reload}>
                <RefreshCw aria-hidden="true" />
                Coba lagi
              </Button>
            </div>
          ) : !view ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <>
              <div aria-live="assertive" className="empty:hidden" data-testid="approval-refusal">
                {refusal ? <Notice tone="error">{refusal}</Notice> : null}
              </div>
              <Facts view={view} />
              {view.status === "PENDING" && canDecide(user) ? (
                <DecisionForm
                  view={view}
                  onDecided={(message) => {
                    setRefusal(message);
                    detail.reload();
                    onDecided();
                  }}
                />
              ) : view.status === "PENDING" ? (
                <Notice tone="warning">Akun Anda hanya bisa melihat. Keputusan butuh hak akses Keputusan tingkat ubah.</Notice>
              ) : (
                <Outcome view={view} />
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Facts({ view }: { view: ExceptionView }) {
  return (
    <div className="flex flex-col gap-4" data-testid="approval-facts">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge info={exceptionStatusInfo(view.status)} />
        {view.status === "PENDING" ? <span className="text-sm text-muted-foreground">menunggu {waitedFor(view.raisedAt)}</span> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground">Plat registrasi dan kamera</dt>
          <dd className="mt-1">
            <PlateComparison view={view} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Timbangan</dt>
          <dd>{view.station ? `${view.station.name} (${view.station.code})` : "-"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Nomor trip</dt>
          <dd className="font-mono">{view.trip.tripNo ?? "-"}</dd>
        </div>
        {view.type !== "PLATE" ? (
          <>
            <div>
              <dt className="text-xs text-muted-foreground">{referenceLabel(view.type)}</dt>
              <dd className="font-mono text-base font-semibold">{kg(view.expectedValue)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Timbangan</dt>
              <dd className="font-mono text-base font-semibold">{kg(view.actualValue)}</dd>
            </div>
            <div className="col-span-2 flex items-end justify-between rounded-xl border bg-surface px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">Selisih</dt>
              <dd>
                <DifferenceFigure view={view} />
              </dd>
            </div>
          </>
        ) : null}
        <div>
          <dt className="text-xs text-muted-foreground">Berat terakhir dari timbangan</dt>
          <dd className="font-mono">{kg(view.liveWeightKg)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Dikirim</dt>
          <dd className="tabular-nums">{formatDateTime(view.liveWeightAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

function Outcome({ view }: { view: ExceptionView }) {
  const decision = decisionLabel(view.decision);
  return (
    <div className="flex flex-col gap-2 rounded-2xl border bg-surface p-4 text-sm" data-testid="approval-outcome">
      <p className="font-semibold">{decision ? `Keputusan: ${decision}` : exceptionStatusInfo(view.status).label}</p>
      {view.decidedBy ? (
        <p className="text-muted-foreground">
          Oleh {view.decidedBy.fullName ?? "-"}, {formatDateTime(view.decidedAt)}
        </p>
      ) : null}
      {view.reason ? <p>Alasan: {view.reason}</p> : null}
      {view.reportNo ? (
        <p>
          Berita Acara <span className="font-mono">{view.reportNo}</span>
        </p>
      ) : null}
      {view.context && (view.context as { masterTareUpdated?: boolean }).masterTareUpdated ? <p>Tarra master kendaraan diganti dengan berat ini.</p> : null}
    </div>
  );
}

/** `onDecided(null)` after a decision, `onDecided(message)` when the server refused it. */
function DecisionForm({ view, onDecided }: { view: ExceptionView; onDecided: (refusal: string | null) => void }) {
  const reasonRequired = needsReason(view.type);
  const choices = view.type === "NET_OUT" ? CHOICES.NET_OUT : CHOICES.default;
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [masterTare, setMasterTare] = useState(false);
  const [sending, setSending] = useState<Decision | null>(null);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function decide(decision: Decision) {
    if (sending || sent) return;
    if (reasonRequired && reason.trim().length < 3) {
      setReasonError("Isi alasan, minimal 3 huruf.");
      return;
    }
    setReasonError(undefined);
    setFailure(null);
    setSending(decision);
    try {
      await api.request(`/api/exceptions/${encodeURIComponent(String(view.id))}/decide`, {
        method: "POST",
        body: {
          decision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(view.type === "TARE_OUT" && decision === "APPROVE" && masterTare ? { updateMasterTare: true } : {}),
        },
      });
      setSent(true);
      onDecided(null);
    } catch (error) {
      if (isApiError(error) && error.code === "VALIDATION") {
        // a field the server checks differently: say so and let the person try again
        setFailure(decisionErrorMessage(error));
      } else {
        // decided by someone else, cancelled, or gone: the detail reloads to show what holds now
        setSent(true);
        onDecided(decisionErrorMessage(error));
      }
    }
    setSending(null);
  }

  return (
    <section aria-label="Keputusan" className="flex flex-col gap-4 rounded-2xl border border-signal/50 p-4" data-testid="approval-decide">
      <p className="text-sm text-muted-foreground">{consequence(view.type)}</p>
      <TextAreaField
        label="Alasan"
        name="decisionReason"
        value={reason}
        onChange={(value) => {
          setReason(value);
          if (reasonError) setReasonError(undefined);
        }}
        optional={!reasonRequired}
        error={reasonError}
        rows={3}
      />
      {view.type === "TARE_OUT" ? (
        <CheckboxField
          name="updateMasterTare"
          label="Jadikan tarra master"
          description="Bila disetujui, tarra kendaraan diganti dengan berat timbang ini."
          checked={masterTare}
          onChange={setMasterTare}
        />
      ) : null}
      <div aria-live="assertive">{failure ? <Notice tone="error">{failure}</Notice> : null}</div>
      <div className="flex flex-wrap gap-2">
        {choices.map((choice) => (
          <Button key={choice.value} variant={choice.variant} size="lg" disabled={sending !== null || sent} onClick={() => void decide(choice.value)}>
            {sending === choice.value ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {choice.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
