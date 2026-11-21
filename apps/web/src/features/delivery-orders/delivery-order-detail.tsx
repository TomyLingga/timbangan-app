"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ListPlus } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { AccessDenied, ListEmpty, ListError, ListSkeleton } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate, formatDateTime, formatNumber, formatQuantity } from "@/lib/format";
import { canCreateOutgoing, canView } from "@/lib/permissions";
import { api } from "@/lib/session";
import { deliveryOrderStatusInfo, registryStatusInfo, tripStatusInfo } from "@/lib/status";
import type { DeliveryOrderDetail, Trip, User } from "@/lib/types";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

function truckColumns(uom: string, linkRegistrations: boolean): ReadonlyArray<Column<Trip>> {
  return [
    {
      id: "plate",
      header: "Truk",
      primary: true,
      cell: (trip) => (
        <>
          <span className="font-medium whitespace-nowrap">{trip.vehicle?.plateDisplay ?? "-"}</span>
          <span className="block text-xs text-muted-foreground">
            {linkRegistrations ? (
              <Link
                href={`/registrasi/${encodeURIComponent(String(trip.registrationId))}`}
                className="text-link underline-offset-4 hover:underline"
              >
                Truk {trip.seq} di registrasinya
              </Link>
            ) : (
              `Truk ${trip.seq}`
            )}
          </span>
        </>
      ),
    },
    {
      id: "driver",
      header: "Supir",
      cell: (trip) => (
        <>
          <span className="block">{trip.driver?.fullName ?? "-"}</span>
          <StatusBadge info={registryStatusInfo(trip.driver?.registryStatus)} />
        </>
      ),
    },
    {
      id: "plan",
      header: "Rencana",
      align: "right",
      cell: (trip) => (
        <>
          <span className="block whitespace-nowrap">{formatQuantity(trip.qtyPlanned, uom)}</span>
          <span className="block text-xs text-muted-foreground">{formatDate(trip.plannedArrival)}</span>
        </>
      ),
    },
    {
      id: "spj",
      header: "SPJ dan kartu",
      wide: true,
      cell: (trip) => (
        <>
          <span className="block">{trip.spj?.spjNo ?? "-"}</span>
          <span className="block text-xs text-muted-foreground">
            {trip.card ? `Kartu ${trip.card.label ?? trip.card.uid} · masuk ${formatDateTime(trip.checkedInAt)}` : trip.tripNo ?? ""}
          </span>
        </>
      ),
    },
    { id: "status", header: "Status", cell: (trip) => <StatusBadge info={tripStatusInfo(trip.status)} /> },
  ];
}

function DeliveryOrderView({ user, id }: { user: User; id: string }) {
  const query = useApiQuery(`do|${id}`, (signal) =>
    api.request<DeliveryOrderDetail>(`/api/delivery-orders/${encodeURIComponent(id)}`, { signal }),
  );
  if (query.hasError) return <ListError title="DO belum bisa dimuat" error={query.error} onRetry={query.reload} />;
  if (!query.data) return <ListSkeleton label="Memuat DO" />;
  const { deliveryOrder: order, trips } = query.data;
  const accepted = order.status.toUpperCase() === "ACCEPTED";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/delivery-order" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Daftar DO
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">{order.doNo}</h1>
          <StatusBadge info={deliveryOrderStatusInfo(order.status)} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {order.partner.name} · {order.product.name}
        </p>
      </div>

      {accepted && canCreateOutgoing(user) ? (
        <div>
          <Button asChild>
            <Link href={`/registrasi/baru?arah=out&do=${encodeURIComponent(String(order.id))}`}>
              <ListPlus aria-hidden="true" />
              Isi daftar truk
            </Link>
          </Button>
        </div>
      ) : null}

      <section className="rounded-2xl border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Data DO</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Tanggal DO">{formatDate(order.doDate)}</Fact>
          <Fact label="Kontrak">{order.contract?.contractNo ?? "Tanpa kontrak"}</Fact>
          <Fact label="PO customer">{order.customerPoNo ?? "-"}</Fact>
          <Fact label="Quantity">{formatQuantity(order.qty, order.uom)}</Fact>
          <Fact label="Sudah direncanakan">{formatQuantity(order.qtyPlanned, order.uom)}</Fact>
          <Fact label="Sisa">{formatQuantity(order.qtyRemaining, order.uom)}</Fact>
          <Fact label="Toleransi">{formatNumber(order.tolerancePct)}%</Fact>
          <Fact label="Tujuan">
            {order.destination.name}
            <span className="block text-xs text-muted-foreground">
              {[order.destination.address, order.destination.regency, order.destination.province].filter(Boolean).join(", ")}
            </span>
          </Fact>
          <Fact label="Masa kirim">
            {formatDate(order.deliveryFrom)}
            {order.deliveryUntil ? ` sampai ${formatDate(order.deliveryUntil)}` : ""}
          </Fact>
          <Fact label="Transporter">{order.transporter?.name ?? "Belum dipilih"}</Fact>
          <Fact label="Jumlah truk">
            {formatNumber(order.tripCount)}
            {order.truckCount ? ` dari ${formatNumber(order.truckCount)}` : ""}
          </Fact>
          <Fact label="Syarat angkut">{order.transportTerms ?? "-"}</Fact>
          {order.sentAt ? <Fact label="Dikirim">{formatDateTime(order.sentAt)}</Fact> : null}
          {order.acceptedAt ? <Fact label="Diterima">{formatDateTime(order.acceptedAt)}</Fact> : null}
          {order.remark ? <Fact label="Catatan">{order.remark}</Fact> : null}
        </dl>
      </section>

      <section aria-labelledby="do-trucks" className="flex flex-col gap-3">
        <h2 id="do-trucks" className="text-sm font-semibold">
          Truk ({formatNumber(trips.length)})
        </h2>
        {trips.length === 0 ? (
          <ListEmpty title="Belum ada truk" hint="Truk muncul di sini setelah transporter mengisi daftar truk DO ini." />
        ) : (
          <div data-testid="do-trucks">
            <DataList columns={truckColumns(order.uom, canView(user, "registrations"))} rows={trips} rowKey={(trip) => trip.id} />
          </div>
        )}
      </section>
    </div>
  );
}

export function DeliveryOrderDetailScreen() {
  const params = useParams<{ id: string }>();
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canView(state.user, "delivery_orders")) return <AccessDenied module="delivery_orders" />;
  return <DeliveryOrderView user={state.user} id={params.id} />;
}
