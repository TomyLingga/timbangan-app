"use client";

import { useId } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { SelectField } from "@/components/form-fields";
import {
  AccessDenied,
  ListEmpty,
  ListError,
  ListSkeleton,
  PageHeader,
  ResultCount,
  SearchField,
} from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useUrlFilter } from "@/hooks/use-url-filter";
import { TotalFigure } from "@/components/total-figure";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatDate, formatNumber, formatQuantity } from "@/lib/format";
import { canTypeIncoming, canTypeOutgoing, canView, isStaff } from "@/lib/permissions";
import { api } from "@/lib/session";
import { registrationStatusInfo } from "@/lib/status";
import type { Page, RegistrationSummary, User } from "@/lib/types";

const LIST_LIMIT = 50;

export const DIRECTION_LABELS: Record<string, string> = { IN: "Incoming", OUT: "Outgoing" };

const STATUS_FILTERS = [
  { value: "DRAFT", label: "Draf" },
  { value: "SUBMITTED", label: "Menunggu tinjauan" },
  { value: "APPROVED", label: "Disetujui" },
  { value: "REJECTED", label: "Ditolak" },
  { value: "CANCELLED", label: "Batal" },
];

const COLUMNS: ReadonlyArray<Column<RegistrationSummary>> = [
  {
    id: "regNo",
    header: "Nomor registrasi",
    primary: true,
    cell: (registration) => (
      <>
        <Link
          href={`/registrasi/${encodeURIComponent(String(registration.id))}`}
          className="font-medium text-link underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {registration.regNo}
        </Link>
        <span className="block text-xs text-muted-foreground">
          {[DIRECTION_LABELS[registration.direction ?? ""] ?? registration.direction, formatDate(registration.plannedDate ?? null)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </>
    ),
  },
  {
    id: "partner",
    header: "Partner dan transporter",
    cellClassName: "max-w-56",
    cell: (registration) => (
      <>
        <span className="block truncate" title={registration.partner?.name}>
          {registration.partner?.name ?? "-"}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{registration.transporter?.name ?? "Tanpa transporter"}</span>
      </>
    ),
  },
  {
    id: "documents",
    header: "Kontrak atau DO",
    wide: true,
    cellClassName: "max-w-56 whitespace-normal",
    cell: (registration) =>
      (registration.allocations ?? []).map((allocation) => allocation.doNo ?? allocation.contractNo).filter(Boolean).join(", ") || "-",
  },
  {
    id: "trucks",
    header: "Truk",
    align: "right",
    cell: (registration) => (
      <>
        <span className="block">{formatNumber(registration.truckCount)}</span>
        <span className="block text-xs whitespace-nowrap text-muted-foreground">
          {formatQuantity(registration.qtyTotal ?? null, registration.uom ?? "Kg")}
        </span>
      </>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (registration) => {
      const findings = registration.findings?.length ?? 0;
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge info={registrationStatusInfo(registration.status)} />
          {findings > 0 ? <StatusBadge info={{ label: `${formatNumber(findings)} temuan`, tone: "warning" }} /> : null}
        </span>
      );
    },
  },
];

function RegistrationsPage({ user }: { user: User }) {
  const ids = useId();
  const [searchText, setSearchText] = useUrlFilter("q");
  const [direction, setDirection] = useUrlFilter("arah");
  const [status, setStatus] = useUrlFilter("status");
  const search = useDebouncedValue(searchText.trim(), 300);

  const list = useApiQuery(
    `${search}|${direction}|${status}`,
    (signal) =>
      api.request<Page<RegistrationSummary>>("/api/registrations", {
        query: { q: search, direction, status, limit: LIST_LIMIT },
        signal,
      }),
    { keepPrevious: true },
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Registrasi" figures={list.data ? <TotalFigure value={list.data.total} noun="registrasi" /> : null} description={isStaff(user) ? "Pendaftaran truk oleh pemasok dan transporter, dan registrasi di pos dari scan dokumen. Registrasi tanpa temuan langsung mendapat SPJ; yang punya temuan ditinjau admin logistik." : "Pendaftaran truk sebelum datang. Registrasi tanpa temuan langsung mendapat SPJ; yang punya temuan ditinjau admin logistik."}>
        {canTypeIncoming(user) ? (
          <Button asChild>
            <Link href="/registrasi/baru?arah=in">
              <Plus aria-hidden="true" />
              Registrasi incoming
            </Link>
          </Button>
        ) : null}
        {canTypeOutgoing(user) ? (
          <Button asChild variant={canTypeIncoming(user) ? "outline" : "default"}>
            <Link href="/registrasi/baru?arah=out">
              <Plus aria-hidden="true" />
              Registrasi outgoing
            </Link>
          </Button>
        ) : null}
      </PageHeader>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <SearchField
          id={`${ids}-search`}
          label="Cari registrasi"
          placeholder="Nomor registrasi, plat, kontrak, atau DO"
          value={searchText}
          onChange={setSearchText}
        />
        <SelectField
          label="Arah"
          name="directionFilter"
          value={direction}
          onChange={setDirection}
          emptyLabel="Semua arah"
          options={[
            { value: "IN", label: "Incoming" },
            { value: "OUT", label: "Outgoing" },
          ]}
          className="w-full sm:max-w-44"
        />
        <SelectField
          label="Status"
          name="statusFilter"
          value={status}
          onChange={setStatus}
          emptyLabel="Semua status"
          options={STATUS_FILTERS}
          className="w-full sm:max-w-56"
        />
      </div>

      {list.hasError ? (
        <ListError title="Daftar registrasi belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar registrasi" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada registrasi yang cocok"
          hint={search || direction || status ? "Ubah pencarian atau saringan." : "Belum ada registrasi."}
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="registrasi" />
          <DataList columns={COLUMNS} rows={list.data.items} rowKey={(registration) => registration.id} stale={list.isStale} />
        </div>
      )}
    </div>
  );
}

export function RegistrationsScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canView(state.user, "registrations")) return <AccessDenied module="registrations" />;
  return <RegistrationsPage user={state.user} />;
}
