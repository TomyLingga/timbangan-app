"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ellipsis, ListPlus, Plus } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { SelectField } from "@/components/form-fields";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, Notice, PageHeader, ResultCount, SearchField } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { TotalFigure } from "@/components/total-figure";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/features/auth/auth-provider";
import { RequestActionSheet, ShipmentRequestFormSheet, type RequestAction } from "@/features/shipment-requests/shipment-request-sheets";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useUrlFilter } from "@/hooks/use-url-filter";
import { formatDate, formatNumber, formatQuantity } from "@/lib/format";
import { canCreateShipmentRequest, canManageShipmentRequests, canSeeShipmentRequests, isStaff } from "@/lib/permissions";
import { api } from "@/lib/session";
import { deliveryWindowText, registerHref, requestActions, shipmentRequestStatusInfo, statusFilters } from "@/lib/shipment-requests";
import type { Page, ShipmentRequest, User } from "@/lib/types";

const LIST_LIMIT = 50;

export const requestHref = (request: Pick<ShipmentRequest, "id">) => `/permintaan-pengiriman/${encodeURIComponent(String(request.id))}`;

function columnsFor(staff: boolean): ReadonlyArray<Column<ShipmentRequest>> {
  const columns: Array<Column<ShipmentRequest> | null> = [
    {
      id: "contract",
      header: "Kontrak",
      primary: true,
      cellClassName: "min-w-44 max-w-60 whitespace-normal",
      cell: (request) => (
        <>
          <span className="flex flex-wrap items-center gap-2">
            <Link
              href={requestHref(request)}
              className="font-medium text-link underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {request.contract.contractNo}
            </Link>
            <StatusBadge info={shipmentRequestStatusInfo(request.status)} className="md:hidden" />
          </span>
          <span className="block text-xs text-muted-foreground">
            {request.sentAt ? `Dikirim ${formatDate(request.sentAt)}` : `Dibuat ${formatDate(request.createdAt)}`}
          </span>
        </>
      ),
    },
    staff
      ? {
          id: "supplier",
          header: "PKS dan partner kontrak",
          cellClassName: "max-w-56",
          cell: (request) => (
            <>
              <span className="block truncate" title={request.supplier.name}>
                {request.supplier.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground" title={request.partner.name}>
                {request.partner.id === request.supplier.id ? request.product.name : `${request.partner.name} · ${request.product.name}`}
              </span>
            </>
          ),
        }
      : { id: "product", header: "Barang", cell: (request) => request.product.name },
    {
      id: "qty",
      header: "Quantity",
      align: "right",
      cell: (request) => (
        <>
          <span className="block whitespace-nowrap">{request.qtyPlanned === null ? "Sisa kontrak" : formatQuantity(request.qtyPlanned, request.uom)}</span>
          <span className="block text-xs whitespace-nowrap text-muted-foreground">Kontrak {formatQuantity(request.contract.qtyContract, request.contract.uom)}</span>
        </>
      ),
    },
    { id: "window", header: "Masa kirim", wide: true, cellClassName: "whitespace-normal", cell: (request) => deliveryWindowText(request) },
    { id: "files", header: "Lampiran", align: "right", cell: (request) => formatNumber(request.fileCount) },
    {
      id: "status",
      header: "Status",
      cellClassName: "hidden md:table-cell",
      cell: (request) => <StatusBadge info={shipmentRequestStatusInfo(request.status)} />,
    },
  ];
  return columns.filter((column): column is Column<ShipmentRequest> => column !== null);
}

type Pending = { kind: "edit"; request: ShipmentRequest | null } | { kind: RequestAction; request: ShipmentRequest };

function ShipmentRequestsPage({ user }: { user: User }) {
  const router = useRouter();
  const staff = isStaff(user);
  const mayCreate = canCreateShipmentRequest(user);
  const mayManage = canManageShipmentRequests(user);
  const ids = useId();
  const [searchText, setSearchText] = useUrlFilter("q");
  const [status, setStatus] = useUrlFilter("status");
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const search = useDebouncedValue(searchText.trim(), 300);
  const list = useApiQuery(
    `${search}|${status}|${reloadToken}`,
    (signal) => api.request<Page<ShipmentRequest>>("/api/shipment-requests", { query: { q: search, status, limit: LIST_LIMIT }, signal }),
    { keepPrevious: true },
  );
  const columns = useMemo(() => columnsFor(staff), [staff]);

  function done(message: string) {
    setPending(null);
    setNotice(message);
    setReloadToken((token) => token + 1);
  }

  function rowActions(request: ShipmentRequest) {
    const register = registerHref(user, request);
    const allowed = requestActions(request);
    const menu =
      mayManage && allowed.edit ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-10 md:h-8" aria-label={`Tindakan ${request.contract.contractNo}`}>
              <Ellipsis aria-hidden="true" />
              <span className="md:sr-only">Tindakan</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => setPending({ kind: "edit", request })}>
              Ubah
            </DropdownMenuItem>
            {allowed.send ? (
              <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => setPending({ kind: "send", request })}>
                Kirim ke supplier
              </DropdownMenuItem>
            ) : null}
            {allowed.close ? (
              <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => setPending({ kind: "close", request })}>
                Tutup permintaan
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem className="min-h-11 text-destructive md:min-h-9" onSelect={() => setPending({ kind: "cancel", request })}>
              Batalkan permintaan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null;
    if (!register && !menu) return null;
    return (
      <span className="flex items-center justify-end gap-1">
        {register ? (
          <Button asChild size="sm" variant="secondary" className="h-10 md:h-8">
            <Link href={register} aria-label={`Daftarkan truk untuk ${request.contract.contractNo}`}>
              <ListPlus aria-hidden="true" />
              Daftarkan truk
            </Link>
          </Button>
        ) : null}
        {menu}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Permintaan pengiriman"
        figures={list.data ? <TotalFigure value={list.data.total} noun="permintaan" /> : null}
        description={
          staff
            ? "Pilih kontrak beli, lampirkan PDF kontrak, lalu kirim ke supplier. Supplier hanya bisa mendaftarkan truk untuk kontrak yang sudah dikirim."
            : "Permintaan pengiriman dari INL untuk perusahaan Anda. Daftarkan truk dari permintaan yang masih terkirim."
        }
      >
        {mayCreate ? (
          <Button onClick={() => setPending({ kind: "edit", request: null })}>
            <Plus aria-hidden="true" />
            Permintaan baru
          </Button>
        ) : null}
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <SearchField
          id={`${ids}-search`}
          label="Cari permintaan"
          placeholder={staff ? "Nomor kontrak atau supplier" : "Nomor kontrak"}
          value={searchText}
          onChange={setSearchText}
        />
        <SelectField
          label="Status"
          name="statusFilter"
          value={status}
          onChange={setStatus}
          emptyLabel="Semua status"
          options={statusFilters(staff)}
          className="w-full sm:max-w-56"
        />
      </div>

      {list.hasError ? (
        <ListError title="Daftar permintaan belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar permintaan" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada permintaan yang cocok"
          hint={search || status ? "Ubah pencarian atau saringan status." : staff ? "Belum ada permintaan pengiriman." : "Belum ada permintaan pengiriman untuk perusahaan Anda."}
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3" data-testid="shipment-requests">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="permintaan" />
          <DataList columns={columns} rows={list.data.items} rowKey={(request) => request.id} stale={list.isStale} actions={rowActions} />
        </div>
      )}

      {pending?.kind === "edit" ? (
        <ShipmentRequestFormSheet
          request={pending.request}
          onClose={() => setPending(null)}
          onSaved={(saved, created) => {
            if (created) {
              // close the sheet first: the list stays mounted (hidden) after the navigation, and so would its sheet
              setPending(null);
              router.push(`${requestHref(saved)}?baru=1`);
              return;
            }
            done(`Permintaan ${saved.contract.contractNo} diperbarui.`);
          }}
        />
      ) : pending ? (
        <RequestActionSheet request={pending.request} action={pending.kind} onClose={() => setPending(null)} onDone={done} />
      ) : null}
    </div>
  );
}

export function ShipmentRequestsScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canSeeShipmentRequests(state.user)) return <AccessDenied module="shipment_requests" />;
  return <ShipmentRequestsPage user={state.user} />;
}
