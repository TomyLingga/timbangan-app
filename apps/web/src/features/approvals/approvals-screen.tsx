"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, PageHeader } from "@/components/page-parts";
import { Segmented } from "@/components/segmented";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { ApprovalSheet } from "@/features/approvals/approval-sheet";
import { DifferenceFigure, PlateComparison } from "@/features/approvals/exception-figures";
import { useApiQuery } from "@/hooks/use-api-query";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { formatNumber } from "@/lib/format";
import { DECISION_PARAM } from "@/lib/notifications";
import { canDecide, canSeeApprovals, canView } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { ExceptionView, User } from "@/lib/types";
import { exceptionStatusInfo, exceptionTypeLabel, referenceLabel, waitedFor } from "@/lib/weighing";

const REFRESH_MS = 5000;
const LIST_LIMIT = 50;

type Show = "PENDING" | "ALL";

const kg = (value: number | null) => (value === null ? "-" : `${formatNumber(value)} kg`);

/** What the list holds for this account: the API lists only the types of the modules it holds. */
function pageDescription(user: User): string {
  const weighbridge = canView(user, "approvals");
  const qc = canView(user, "qc_approvals");
  const what =
    weighbridge && qc
      ? "Permintaan dari timbangan saat plat tidak cocok atau berat melewati toleransi, dan hasil QC yang ditahan."
      : qc
        ? "Hasil QC yang ditahan dan menunggu keputusan."
        : "Permintaan dari timbangan saat plat tidak cocok atau berat melewati toleransi.";
  return `${what} Daftar diperbarui tiap 5 detik.`;
}

function columns(now: number): ReadonlyArray<Column<ExceptionView>> {
  return [
    {
      id: "type",
      header: "Permintaan",
      primary: true,
      cell: (view) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{exceptionTypeLabel(view.type)}</span>
          <span className="text-xs text-muted-foreground">
            {[view.station?.name, view.stage ? `timbang ${view.stage}` : null, view.trip.tripNo].filter(Boolean).join(", ")}
          </span>
        </span>
      ),
    },
    { id: "plate", header: "Plat", cell: (view) => <PlateComparison view={view} /> },
    {
      id: "figures",
      header: "Surat dan timbangan",
      align: "right",
      cell: (view) =>
        view.type === "PLATE" ? (
          <span className="font-mono">{kg(view.liveWeightKg)}</span>
        ) : (
          <span className="flex flex-col items-end">
            <span className="font-mono">{kg(view.actualValue ?? view.liveWeightKg)}</span>
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {referenceLabel(view.type)} {kg(view.expectedValue)}
            </span>
          </span>
        ),
    },
    { id: "difference", header: "Selisih", align: "right", cell: (view) => <DifferenceFigure view={view} /> },
    {
      id: "waited",
      header: "Menunggu",
      cell: (view) =>
        view.status === "PENDING" ? (
          <span className="font-medium tabular-nums">{waitedFor(view.raisedAt, now)}</span>
        ) : (
          <StatusBadge info={exceptionStatusInfo(view.status)} />
        ),
    },
  ];
}

/**
 * The request open in the sheet, kept in the address bar (`?permintaan=7`) so the bell can link to one request.
 * Writing it with history.replaceState and no state of our own lets Next.js update useSearchParams without a
 * navigation, so the list keeps its filter.
 */
function useOpenRequest(): [string | null, (id: string | number | null) => void] {
  const openId = useSearchParams().get(DECISION_PARAM) || null;
  const setOpenId = (id: string | number | null) => {
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete(DECISION_PARAM);
    else url.searchParams.set(DECISION_PARAM, String(id));
    window.history.replaceState(null, "", url);
  };
  return [openId, setOpenId];
}

function ApprovalsPage({ user }: { user: User }) {
  const [show, setShow] = useState<Show>("PENDING");
  const [openId, setOpenId] = useOpenRequest();
  const list = useApiQuery(
    `exceptions|${show}`,
    (signal) => api.request<{ items: ExceptionView[] }>("/api/exceptions", { query: { status: show === "PENDING" ? "PENDING" : undefined, limit: LIST_LIMIT }, signal }),
    { keepPrevious: true },
  );
  // the clock for "how long it waited", moved on with every refresh
  const [now, setNow] = useState(() => Date.now());
  useVisibleInterval(() => {
    list.reload();
    setNow(Date.now());
  }, REFRESH_MS);

  const items = list.data?.items ?? [];
  const waiting = show === "PENDING" ? items.length : items.filter((item) => item.status === "PENDING").length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Keputusan"
        figures={
          list.data ? (
            <span>
              <span className="font-semibold text-foreground tabular-nums">{formatNumber(waiting)}</span> menunggu keputusan
            </span>
          ) : null
        }
        description={pageDescription(user)}
      />

      <Segmented<Show>
        label="Tampilkan"
        value={show}
        onChange={setShow}
        options={[
          { value: "PENDING", label: "Menunggu" },
          { value: "ALL", label: "Semua" },
        ]}
      />

      {list.hasError && !list.data ? (
        <ListError title="Daftar permintaan belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar permintaan" />
      ) : items.length === 0 ? (
        <ListEmpty
          title={show === "PENDING" ? "Tidak ada yang menunggu keputusan" : "Belum ada permintaan"}
          hint={show === "PENDING" ? "Permintaan baru muncul di sini dengan sendirinya." : undefined}
        />
      ) : (
        <div data-testid="approval-list">
          <DataList
            columns={columns(now)}
            rows={items}
            rowKey={(view) => view.id}
            actions={(view) => {
              // a request the account may only read opens as Rincian
              const decide = view.status === "PENDING" && canDecide(user, view);
              return (
                <Button
                  variant={decide ? "default" : "outline"}
                  size="sm"
                  className="h-10 md:h-8"
                  onClick={() => setOpenId(view.id)}
                  aria-label={`Rincian ${exceptionTypeLabel(view.type)} ${view.trip.plateDisplay ?? view.plateNo ?? ""}`.trim()}
                >
                  {decide ? "Putuskan" : "Rincian"}
                  <ArrowRight aria-hidden="true" />
                </Button>
              );
            }}
          />
        </div>
      )}

      {openId !== null ? (
        <ApprovalSheet
          id={openId}
          user={user}
          onClose={() => setOpenId(null)}
          onDecided={() => list.reload()}
        />
      ) : null}
    </div>
  );
}

export function ApprovalsScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canSeeApprovals(state.user)) {
    return (
      <AccessDenied
        module="approvals"
        reason="Halaman ini untuk pemegang hak Keputusan selisih dan plat atau Keputusan QC. Minta admin sistem memberi Anda salah satunya."
      />
    );
  }
  return <ApprovalsPage user={state.user} />;
}
