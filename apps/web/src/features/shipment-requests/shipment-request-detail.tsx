"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, ListPlus, Pencil, Send } from "lucide-react";

import { AttachmentList } from "@/components/attachments";
import { AccessDenied, ListError, ListSkeleton, Notice } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { RequestActionSheet, ShipmentRequestFormSheet, type RequestAction } from "@/features/shipment-requests/shipment-request-sheets";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate, formatDateTime, formatNumber, formatQuantity } from "@/lib/format";
import { canManageShipmentRequests, canSeeShipmentRequests, isStaff } from "@/lib/permissions";
import { api } from "@/lib/session";
import {
  canChangeRequestFiles,
  canRemoveRequestFile,
  deliveryWindowText,
  MAX_REQUEST_FILES,
  registerHref,
  requestActions,
  shipmentRequestStatusInfo,
} from "@/lib/shipment-requests";
import type { ShipmentRequestDetail, User } from "@/lib/types";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

const by = (person: { fullName: string | null } | null, at: string | null) => [person?.fullName, formatDateTime(at)].filter(Boolean).join(", ");

function ShipmentRequestView({ user, id }: { user: User; id: string }) {
  const searchParams = useSearchParams();
  const [notice, setNotice] = useState<string | null>(searchParams.get("baru") ? "Permintaan dibuat sebagai draf. Lampirkan PDF kontrak, lalu kirim ke supplier." : null);
  const [pending, setPending] = useState<"edit" | RequestAction | null>(null);
  const query = useApiQuery(`shipment-request|${id}`, (signal) =>
    api.request<ShipmentRequestDetail>(`/api/shipment-requests/${encodeURIComponent(id)}`, { signal }),
  );
  if (query.hasError) return <ListError title="Permintaan pengiriman belum bisa dimuat" error={query.error} onRetry={query.reload} />;
  if (!query.data) return <ListSkeleton label="Memuat permintaan pengiriman" />;
  const { shipmentRequest: request, files } = query.data;
  const staff = isStaff(user);
  const mayManage = canManageShipmentRequests(user);
  const allowed = requestActions(request);
  const register = registerHref(user, request);
  const filesPath = `/api/shipment-requests/${encodeURIComponent(String(request.id))}/files`;
  const changeFiles = canChangeRequestFiles(user, request);

  function done(message: string) {
    setPending(null);
    setNotice(message);
    query.reload();
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/permintaan-pengiriman" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Daftar permintaan
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">{request.contract.contractNo}</h1>
          <StatusBadge info={shipmentRequestStatusInfo(request.status)} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {request.partner.name} · {request.product.name}
        </p>
      </div>

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>

      {register || (mayManage && allowed.edit) ? (
        <div className="flex flex-wrap gap-2" data-testid="request-actions">
          {register ? (
            <Button asChild>
              <Link href={register}>
                <ListPlus aria-hidden="true" />
                Daftarkan truk
              </Link>
            </Button>
          ) : null}
          {mayManage && allowed.send ? (
            <Button onClick={() => setPending("send")}>
              <Send aria-hidden="true" />
              Kirim ke supplier
            </Button>
          ) : null}
          {mayManage && allowed.edit ? (
            <Button variant="outline" onClick={() => setPending("edit")}>
              <Pencil aria-hidden="true" />
              Ubah
            </Button>
          ) : null}
          {mayManage && allowed.close ? (
            <Button variant="outline" onClick={() => setPending("close")}>
              Tutup permintaan
            </Button>
          ) : null}
          {mayManage && allowed.cancel ? (
            <Button variant="ghost" className="text-destructive" onClick={() => setPending("cancel")}>
              Batalkan
            </Button>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-2xl border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Data permintaan</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="request-facts">
          <Fact label="Supplier">{request.partner.name}</Fact>
          <Fact label="Barang">{request.product.name}</Fact>
          <Fact label="Quantity rencana">{request.qtyPlanned === null ? "Mengikuti sisa kontrak" : formatQuantity(request.qtyPlanned, request.uom)}</Fact>
          <Fact label="Quantity kontrak">{formatQuantity(request.contract.qtyContract, request.contract.uom)}</Fact>
          <Fact label="Toleransi kontrak">{request.contract.tolerancePct === null ? "-" : `${formatNumber(request.contract.tolerancePct)}%`}</Fact>
          <Fact label="Masa kirim">{deliveryWindowText(request)}</Fact>
          <Fact label="Kontrak berlaku">
            {request.contract.validFrom ? formatDate(request.contract.validFrom) : "-"}
            {request.contract.validUntil ? ` sampai ${formatDate(request.contract.validUntil)}` : ""}
          </Fact>
          {request.remark ? <Fact label="Keterangan">{request.remark}</Fact> : null}
          {staff ? <Fact label="Dibuat">{by(request.createdBy, request.createdAt)}</Fact> : null}
          {request.sentAt ? <Fact label="Dikirim">{by(request.sentBy, request.sentAt)}</Fact> : null}
          {request.closedAt ? <Fact label="Ditutup">{by(request.closedBy, request.closedAt)}</Fact> : null}
          {request.cancelledAt ? <Fact label="Dibatalkan">{by(request.cancelledBy, request.cancelledAt)}</Fact> : null}
          {request.cancelReason ? <Fact label="Alasan batal">{request.cancelReason}</Fact> : null}
        </dl>
      </section>

      <section aria-labelledby="request-files" className="rounded-2xl border bg-card p-4 sm:p-5">
        <h2 id="request-files" className="text-sm font-semibold">
          Dokumen kontrak ({formatNumber(files.length)})
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {changeFiles
            ? "PDF kontrak untuk supplier. Wajib ada sebelum dikirim. Setelah dikirim, tambah berkas baru dulu sebelum menghapus yang lama."
            : "PDF kontrak dari INL."}
        </p>
        <div className="mt-3">
          <AttachmentList
            title="Dokumen kontrak"
            files={files}
            max={MAX_REQUEST_FILES}
            canChange={changeFiles}
            onAdd={async (file) => {
              await api.request(filesPath, { method: "POST", body: { fileId: file.id } });
              query.reload();
            }}
            onRemove={
              canRemoveRequestFile(request, files.length)
                ? async (file) => {
                    await api.request(`${filesPath}/${encodeURIComponent(String(file.id))}`, { method: "DELETE" });
                    query.reload();
                  }
                : undefined
            }
            emptyText="Belum ada dokumen."
            testId="request-files"
          />
        </div>
      </section>

      {pending === "edit" ? (
        <ShipmentRequestFormSheet
          request={request}
          onClose={() => setPending(null)}
          onSaved={(saved) => done(`Permintaan ${saved.contract.contractNo} diperbarui.`)}
        />
      ) : pending ? (
        <RequestActionSheet request={{ ...request, fileCount: files.length }} action={pending} onClose={() => setPending(null)} onDone={done} />
      ) : null}
    </div>
  );
}

export function ShipmentRequestDetailScreen() {
  const params = useParams<{ id: string }>();
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canSeeShipmentRequests(state.user)) return <AccessDenied module="shipment_requests" />;
  return <ShipmentRequestView user={state.user} id={params.id} />;
}
