"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { CircleCheck, Ellipsis, ListPlus, Plus } from "lucide-react";

import { ActionSheet } from "@/components/action-sheet";
import { ContractLookup } from "@/components/contract-lookup";
import { DataList, type Column } from "@/components/data-list";
import { SelectField, TextAreaField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import {
  AccessDenied,
  ListEmpty,
  ListError,
  ListSkeleton,
  Notice,
  PageHeader,
  ResultCount,
  SearchField,
} from "@/components/page-parts";
import { PartnerLookup } from "@/components/partner-lookup";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useUrlFilter } from "@/hooks/use-url-filter";
import { TotalFigure } from "@/components/total-figure";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { refusedFields, useAction, useFormValues } from "@/hooks/use-form";
import { formatDate, formatNumber, formatQuantity } from "@/lib/format";
import { saveErrorMessage, transitionErrorMessage } from "@/lib/messages";
import {
  canAcceptDeliveryOrder,
  canCreateDeliveryOrder,
  canCreateOutgoing,
  canManageDeliveryOrders,
  canView,
  isStaff,
} from "@/lib/permissions";
import { api } from "@/lib/session";
import { deliveryOrderStatusInfo } from "@/lib/status";
import type { DeliveryOrder, Destination, Page, PartnerRef, Product, User } from "@/lib/types";
import { wholeKg } from "@/lib/quantity";
import {
  deliveryOrderPayload,
  EMPTY_DELIVERY_ORDER,
  validateDeliveryOrder,
  type DeliveryOrderValues,
} from "@/lib/workflow-forms";

const LIST_LIMIT = 50;

const STATUS_FILTERS = [
  { value: "DRAFT", label: "Draf" },
  { value: "SENT", label: "Menunggu transporter" },
  { value: "ACCEPTED", label: "Diterima transporter" },
  { value: "CLOSED", label: "Tutup" },
  { value: "CANCELLED", label: "Batal" },
];

const is = (order: DeliveryOrder, ...statuses: string[]) => statuses.includes(order.status.toUpperCase());

/** "21 Nov 2026 sampai 5 Des 2026", or only the start. */
function deliveryWindow(order: DeliveryOrder): string {
  if (!order.deliveryUntil) return `Mulai ${formatDate(order.deliveryFrom)}`;
  return `${formatDate(order.deliveryFrom)} sampai ${formatDate(order.deliveryUntil)}`;
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function columnsFor(admin: boolean): ReadonlyArray<Column<DeliveryOrder>> {
  const columns: Array<Column<DeliveryOrder> | null> = [
    {
      id: "doNo",
      header: "Nomor DO",
      primary: true,
      cellClassName: "min-w-44 max-w-60 whitespace-normal",
      cell: (order) => (
        <>
          <span className="flex flex-wrap items-center gap-2">
            <Link
              href={`/delivery-order/${encodeURIComponent(String(order.id))}`}
              className="font-medium text-link underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {order.doNo}
            </Link>
            <StatusBadge info={deliveryOrderStatusInfo(order.status)} className="md:hidden" />
          </span>
          <span className="block text-xs text-muted-foreground">
            {[formatDate(order.doDate), order.contract?.contractNo, order.customerPoNo ? `PO ${order.customerPoNo}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </>
      ),
    },
    {
      id: "customer",
      header: "Customer dan barang",
      cellClassName: "max-w-56",
      cell: (order) => (
        <>
          <span className="block truncate" title={order.partner?.name}>
            {order.partner?.name ?? "-"}
          </span>
          <span className="block text-xs text-muted-foreground">{order.product?.name ?? "-"}</span>
        </>
      ),
    },
    {
      id: "qty",
      header: "Quantity",
      align: "right",
      cell: (order) => (
        <>
          <span className="block whitespace-nowrap">{formatQuantity(order.qty, order.uom)}</span>
          <span className="block text-xs whitespace-nowrap text-muted-foreground">
            Sisa {formatQuantity(order.qtyRemaining, order.uom)}
          </span>
        </>
      ),
    },
    {
      id: "destination",
      header: "Tujuan dan masa kirim",
      wide: true,
      cellClassName: "max-w-56 whitespace-normal",
      cell: (order) => (
        <>
          <span className="block">{order.destination?.name ?? "-"}</span>
          <span className="block text-xs text-muted-foreground">{deliveryWindow(order)}</span>
        </>
      ),
    },
    admin
      ? { id: "transporter", header: "Transporter", cellClassName: "max-w-40 whitespace-normal", cell: (order) => order.transporter?.name ?? "Belum dipilih" }
      : null,
    {
      id: "trucks",
      header: "Truk",
      align: "right",
      cell: (order) => (
        <span className="whitespace-nowrap">
          {formatNumber(order.tripCount ?? 0)}
          {order.truckCount ? ` dari ${formatNumber(order.truckCount)}` : ""}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cellClassName: "hidden md:table-cell",
      cell: (order) => <StatusBadge info={deliveryOrderStatusInfo(order.status)} />,
    },
  ];
  return columns.filter((column): column is Column<DeliveryOrder> => column !== null);
}

// --- create and edit (logistics admin) ------------------------------------------

function toValues(order: DeliveryOrder): DeliveryOrderValues {
  const text = (value: number | string | null) => (value === null || value === "" ? "" : String(Number(value)));
  return {
    doNo: order.doNo,
    doDate: order.doDate ?? "",
    contractId: order.contract ? String(order.contract.id) : "",
    partnerId: order.partner ? String(order.partner.id) : "",
    productId: order.product ? String(order.product.id) : "",
    customerPoNo: order.customerPoNo ?? "",
    qty: text(order.qty),
    uom: order.uom ?? "Kg",
    tolerancePct: text(order.tolerancePct),
    destinationId: order.destination ? String(order.destination.id) : "",
    deliveryFrom: order.deliveryFrom ?? "",
    deliveryUntil: order.deliveryUntil ?? "",
    transportTerms: order.transportTerms ?? "",
    transporterId: order.transporter ? String(order.transporter.id) : "",
    truckCount: order.truckCount ? String(order.truckCount) : "",
    remark: order.remark ?? "",
  };
}

function DeliveryOrderFormSheet({
  order,
  onClose,
  onSaved,
}: {
  order: DeliveryOrder | null;
  onClose: () => void;
  onSaved: (order: DeliveryOrder, created: boolean) => void;
}) {
  const limited = order !== null && !is(order, "DRAFT");
  const form = useFormValues<DeliveryOrderValues>(order ? toValues(order) : { ...EMPTY_DELIVERY_ORDER, doDate: today(), deliveryFrom: today() });
  const [contract, setContract] = useState<{ contractNo: string } | null>(order?.contract ? { contractNo: order.contract.contractNo ?? "-" } : null);
  const [customer, setCustomer] = useState<PartnerRef | null>(order?.partner ?? null);
  const [productName, setProductName] = useState<string | null>(order?.product?.name ?? null);
  const [transporter, setTransporter] = useState<PartnerRef | null>(order?.transporter ?? null);
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();

  const customerId = customer ? String(customer.id) : "";
  const destinations = useApiQuery(customerId && !limited ? `destinations|${customerId}` : null, (signal) =>
    api.request<Page<Destination>>("/api/destinations", { query: { partnerId: customerId, limit: 50 }, signal }),
  );
  const products = useApiQuery(!contract && !limited ? "products" : null, (signal) =>
    api.request<Page<Product>>("/api/products", { query: { limit: 50 }, signal }),
  );

  async function handleSubmit() {
    const errors = limited ? {} : validateDeliveryOrder(form.values);
    if (limited && form.values.truckCount.trim() && (wholeKg(form.values.truckCount) ?? 0) < 1) {
      errors.truckCount = "Isi jumlah truk dengan angka bulat lebih dari nol.";
    }
    form.setErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;
    const body = deliveryOrderPayload(form.values, order === null ? "create" : limited ? "limited" : "draft");
    const outcome = await save.run(() =>
      order
        ? api.request<{ deliveryOrder: DeliveryOrder }>(`/api/delivery-orders/${encodeURIComponent(String(order.id))}`, {
            method: "PATCH",
            body,
          })
        : api.request<{ deliveryOrder: DeliveryOrder }>("/api/delivery-orders", { method: "POST", body }),
    );
    if (outcome.ok) {
      onSaved(outcome.value.deliveryOrder, order === null);
    } else {
      form.setErrors(refusedFields<DeliveryOrderValues>(outcome.error));
      setFormError(saveErrorMessage(outcome.error, "Nomor DO ini sudah dipakai."));
    }
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={order ? `Ubah ${order.doNo}` : "DO baru"}
      description={limited ? "DO sudah dikirim, jadi yang bisa diubah hanya batas kirim, jumlah truk, dan catatan." : undefined}
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      {limited ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Nomor DO"
              name="doNo"
              optional
              value={form.values.doNo}
              onChange={(value) => form.set("doNo", value)}
              error={form.errors.doNo}
              hint="Kosongkan supaya nomor dibuat otomatis."
            />
            <TextField
              label="Tanggal DO"
              name="doDate"
              type="date"
              value={form.values.doDate}
              onChange={(value) => form.set("doDate", value)}
              error={form.errors.doDate}
            />
          </div>
          <ContractLookup
            direction="OUT"
            label="Kontrak jual"
            name="contractLookup"
            placeholder="Cari nomor kontrak"
            optional
            value={contract}
            hint="Customer, barang, satuan, dan PO terisi dari kontrak."
            onSelect={(chosen) => {
              setContract(chosen);
              setCustomer(chosen.partner);
              setProductName(chosen.product.name);
              form.set("contractId", String(chosen.id));
              form.set("partnerId", String(chosen.partner.id));
              form.set("productId", String(chosen.product.id));
              form.set("customerPoNo", chosen.customerPoNo ?? "");
              form.set("uom", chosen.uom ?? "Kg");
              form.set("tolerancePct", chosen.tolerancePct === null ? "" : String(Number(chosen.tolerancePct)));
              form.set("destinationId", "");
            }}
            onClear={() => {
              setContract(null);
              form.set("contractId", "");
            }}
            error={form.errors.contractId}
          />
          {contract ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              {customer?.name ?? "-"} · {productName ?? "-"}
            </p>
          ) : (
            <>
              <PartnerLookup
                role="customer"
                label="Customer"
                name="customerLookup"
                placeholder="Cari nama customer"
                value={customer}
                onChange={(partner) => {
                  setCustomer(partner);
                  form.set("partnerId", partner ? String(partner.id) : "");
                  form.set("destinationId", "");
                }}
                error={form.errors.partnerId}
              />
              <SelectField
                label="Barang"
                name="productId"
                value={form.values.productId}
                onChange={(value) => form.set("productId", value)}
                error={form.errors.productId}
                emptyLabel={products.data ? "Pilih barang" : "Memuat daftar barang"}
                options={(products.data?.items ?? []).map((product) => ({ value: String(product.id), label: product.name }))}
              />
            </>
          )}
          <TextField
            label="PO customer"
            name="customerPoNo"
            optional
            value={form.values.customerPoNo}
            onChange={(value) => form.set("customerPoNo", value)}
            error={form.errors.customerPoNo}
          />
          <div className="grid grid-cols-[2fr_1fr] gap-4">
            <TextField
              label="Quantity"
              name="qty"
              inputMode="decimal"
              value={form.values.qty}
              onChange={(value) => form.set("qty", value)}
              error={form.errors.qty}
            />
            <TextField
              label="Satuan"
              name="uom"
              value={form.values.uom}
              onChange={(value) => form.set("uom", value)}
              error={form.errors.uom}
              disabled={contract !== null}
            />
          </div>
          <TextField
            label="Toleransi (%)"
            name="tolerancePct"
            inputMode="decimal"
            optional
            value={form.values.tolerancePct}
            onChange={(value) => form.set("tolerancePct", value)}
            error={form.errors.tolerancePct}
          />
          <SelectField
            label="Tujuan"
            name="destinationId"
            value={form.values.destinationId}
            onChange={(value) => form.set("destinationId", value)}
            error={form.errors.destinationId}
            disabled={!customer}
            emptyLabel={!customer ? "Pilih customer atau kontrak dulu" : destinations.data ? "Pilih tujuan" : "Memuat daftar tujuan"}
            hint={customer && destinations.data?.items.length === 0 ? "Customer ini belum punya tujuan. Tambahkan di halaman Tujuan." : undefined}
            options={(destinations.data?.items ?? []).map((destination) => ({
              value: String(destination.id),
              label: destination.isActive ? destination.name : `${destination.name} (nonaktif)`,
            }))}
          />
          <TextField
            label="Mulai kirim"
            name="deliveryFrom"
            type="date"
            value={form.values.deliveryFrom}
            onChange={(value) => form.set("deliveryFrom", value)}
            error={form.errors.deliveryFrom}
          />
        </>
      )}
      <TextField
        label="Batas kirim"
        name="deliveryUntil"
        type="date"
        optional
        value={form.values.deliveryUntil}
        onChange={(value) => form.set("deliveryUntil", value)}
        error={form.errors.deliveryUntil}
      />
      {limited ? null : (
        <>
          <TextField
            label="Syarat angkut"
            name="transportTerms"
            optional
            value={form.values.transportTerms}
            onChange={(value) => form.set("transportTerms", value)}
            error={form.errors.transportTerms}
          />
          <PartnerLookup
            role="transporter"
            label="Transporter"
            name="transporterLookup"
            placeholder="Cari nama transporter"
            optional
            value={transporter}
            onChange={(partner) => {
              setTransporter(partner);
              form.set("transporterId", partner ? String(partner.id) : "");
            }}
            error={form.errors.transporterId}
          />
        </>
      )}
      <TextField
        label="Jumlah truk"
        name="truckCount"
        inputMode="numeric"
        optional
        value={form.values.truckCount}
        onChange={(value) => form.set("truckCount", value)}
        error={form.errors.truckCount}
        hint="Boleh dikosongkan; transporter mengisinya saat menerima DO."
      />
      <TextAreaField
        label="Catatan"
        name="remark"
        optional
        rows={2}
        value={form.values.remark}
        onChange={(value) => form.set("remark", value)}
        error={form.errors.remark}
      />
    </FormSheet>
  );
}

// --- status changes --------------------------------------------------------------

type Pending =
  | { kind: "edit"; order: DeliveryOrder | null }
  | { kind: "send" | "close" | "cancel" | "accept"; order: DeliveryOrder };

async function transition(order: DeliveryOrder, action: string, body: unknown = {}): Promise<string | null> {
  try {
    await api.request(`/api/delivery-orders/${encodeURIComponent(String(order.id))}/${action}`, { method: "POST", body });
    return null;
  } catch (error) {
    return transitionErrorMessage(error);
  }
}

function AcceptSheet({ order, onClose, onDone }: { order: DeliveryOrder; onClose: () => void; onDone: () => void }) {
  const [truckCount, setTruckCount] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const askCount = !order.truckCount;
  return (
    <ActionSheet
      title={`Terima ${order.doNo}`}
      description={`${order.partner?.name ?? "-"} · ${order.product?.name ?? "-"} · ${formatQuantity(order.qty, order.uom)}`}
      submitLabel="Terima DO"
      onClose={onClose}
      onConfirm={async () => {
        let count: number | undefined;
        if (askCount && truckCount.trim()) {
          const parsed = wholeKg(truckCount);
          if (parsed === null || parsed < 1) {
            setError("Isi jumlah truk dengan angka bulat lebih dari nol.");
            return "Periksa jumlah truk.";
          }
          count = parsed;
        }
        const failure = await transition(order, "accept", count === undefined ? {} : { truckCount: count });
        if (!failure) onDone();
        return failure;
      }}
    >
      {askCount ? (
        <TextField
          label="Jumlah truk"
          name="truckCount"
          inputMode="numeric"
          optional
          value={truckCount}
          onChange={(value) => {
            setTruckCount(value);
            setError(undefined);
          }}
          error={error}
          hint="Admin logistik belum mengisi jumlah truk. Isi perkiraan jumlah truk yang akan dikirim."
        />
      ) : (
        <p className="text-sm">Jumlah truk dari admin logistik: {formatNumber(order.truckCount)}.</p>
      )}
    </ActionSheet>
  );
}

function DeliveryOrdersPage({ user }: { user: User }) {
  const admin = isStaff(user);
  const mayCreate = canCreateDeliveryOrder(user);
  const mayManage = canManageDeliveryOrders(user);
  const mayAccept = canAcceptDeliveryOrder(user);
  const mayFillTrucks = canCreateOutgoing(user);
  const ids = useId();
  const [searchText, setSearchText] = useUrlFilter("q");
  const [status, setStatus] = useUrlFilter("status");
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const search = useDebouncedValue(searchText.trim(), 300);
  const list = useApiQuery(
    `${search}|${status}|${reloadToken}`,
    (signal) =>
      api.request<Page<DeliveryOrder>>("/api/delivery-orders", { query: { q: search, status, limit: LIST_LIMIT }, signal }),
    { keepPrevious: true },
  );
  const columns = useMemo(() => columnsFor(admin), [admin]);

  function done(message: string) {
    setPending(null);
    setNotice(message);
    setReloadToken((token) => token + 1);
  }

  function manageMenu(order: DeliveryOrder) {
    const running = is(order, "DRAFT", "SENT", "ACCEPTED");
    if (!mayManage || !running) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-10 md:h-8" aria-label={`Tindakan ${order.doNo}`}>
            <Ellipsis aria-hidden="true" />
            <span className="md:sr-only">Tindakan</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => setPending({ kind: "edit", order })}>
            Ubah
          </DropdownMenuItem>
          {is(order, "DRAFT") ? (
            <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => setPending({ kind: "send", order })}>
              Kirim ke transporter
            </DropdownMenuItem>
          ) : null}
          {is(order, "ACCEPTED") ? (
            <DropdownMenuItem className="min-h-11 md:min-h-9" onSelect={() => setPending({ kind: "close", order })}>
              Tutup DO
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="min-h-11 text-destructive md:min-h-9"
            onSelect={() => setPending({ kind: "cancel", order })}
          >
            Batalkan DO
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function workActions(order: DeliveryOrder) {
    if (is(order, "SENT") && mayAccept) {
      return (
        <Button size="sm" className="h-10 md:h-8" onClick={() => setPending({ kind: "accept", order })} aria-label={`Terima ${order.doNo}`}>
          <CircleCheck aria-hidden="true" />
          Terima
        </Button>
      );
    }
    if (is(order, "ACCEPTED") && mayFillTrucks) {
      return (
        <Button asChild size="sm" variant="secondary" className="h-10 md:h-8">
          <Link href={`/registrasi/baru?arah=out&do=${encodeURIComponent(String(order.id))}`} aria-label={`Isi daftar truk ${order.doNo}`}>
            <ListPlus aria-hidden="true" />
            Isi daftar truk
          </Link>
        </Button>
      );
    }
    return null;
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Delivery Order"
        figures={list.data ? <TotalFigure value={list.data.total} noun="delivery order" /> : null}
        description={
          admin
            ? "Susun DO, kirim ke transporter, lalu pantau sisanya sampai ditutup."
            : "DO yang dikirim admin logistik kepada perusahaan Anda. Terima DO, lalu isi daftar truknya."
        }
      >
        {mayCreate ? (
          <Button onClick={() => setPending({ kind: "edit", order: null })}>
            <Plus aria-hidden="true" />
            DO baru
          </Button>
        ) : null}
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <SearchField
          id={`${ids}-search`}
          label="Cari DO"
          placeholder="Nomor DO, kontrak, customer, atau PO"
          value={searchText}
          onChange={setSearchText}
        />
        <SelectField
          label="Status"
          name="statusFilter"
          value={status}
          onChange={setStatus}
          emptyLabel="Semua status"
          options={admin ? STATUS_FILTERS : STATUS_FILTERS.filter((option) => option.value !== "DRAFT")}
          className="w-full sm:max-w-56"
        />
      </div>

      {list.hasError ? (
        <ListError title="Daftar DO belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar DO" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada DO yang cocok"
          hint={search || status ? "Ubah pencarian atau saringan status." : admin ? "Belum ada DO." : "Belum ada DO yang dikirim ke perusahaan Anda."}
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="DO" />
          <DataList
            columns={columns}
            rows={list.data.items}
            rowKey={(order) => order.id}
            stale={list.isStale}
            actions={(order) => {
              const work = workActions(order);
              const menu = manageMenu(order);
              if (!work && !menu) return null;
              return (
                <span className="flex items-center justify-end gap-1">
                  {work}
                  {menu}
                </span>
              );
            }}
          />
        </div>
      )}

      {pending?.kind === "edit" ? (
        <DeliveryOrderFormSheet
          order={pending.order}
          onClose={() => setPending(null)}
          onSaved={(order, created) => done(created ? `DO ${order.doNo} dibuat sebagai draf.` : `DO ${order.doNo} diperbarui.`)}
        />
      ) : null}
      {pending?.kind === "send" ? (
        <ActionSheet
          title={`Kirim ${pending.order.doNo}`}
          description={
            pending.order.transporter
              ? `DO dikirim ke ${pending.order.transporter.name}. Setelah dikirim, isi DO tidak bisa diubah lagi kecuali batas kirim, jumlah truk, dan catatan.`
              : "DO ini belum punya transporter. Pilih transporter lewat Ubah, lalu kirim lagi."
          }
          submitLabel="Kirim DO"
          onClose={() => setPending(null)}
          onConfirm={async () => {
            if (!pending.order.transporter) return "Pilih transporter dulu lewat Ubah.";
            const failure = await transition(pending.order, "send");
            if (!failure) done(`DO ${pending.order.doNo} dikirim ke ${pending.order.transporter.name}.`);
            return failure;
          }}
        />
      ) : null}
      {pending?.kind === "close" ? (
        <ActionSheet
          title={`Tutup ${pending.order.doNo}`}
          description={`Sisa ${formatQuantity(pending.order.qtyRemaining, pending.order.uom)}. DO yang ditutup tidak bisa diisi truk lagi.`}
          submitLabel="Tutup DO"
          onClose={() => setPending(null)}
          onConfirm={async () => {
            const failure = await transition(pending.order, "close");
            if (!failure) done(`DO ${pending.order.doNo} ditutup.`);
            return failure;
          }}
        />
      ) : null}
      {pending?.kind === "cancel" ? (
        <ActionSheet
          title={`Batalkan ${pending.order.doNo}`}
          description="DO yang sudah punya truk check-in tidak bisa dibatalkan."
          submitLabel="Batalkan DO"
          reasonLabel="Alasan"
          reasonRequired="Isi alasan pembatalan."
          onClose={() => setPending(null)}
          onConfirm={async (reason) => {
            const failure = await transition(pending.order, "cancel", { reason });
            if (!failure) done(`DO ${pending.order.doNo} dibatalkan.`);
            return failure;
          }}
        />
      ) : null}
      {pending?.kind === "accept" ? (
        <AcceptSheet
          order={pending.order}
          onClose={() => setPending(null)}
          onDone={() => done(`DO ${pending.order.doNo} diterima. Isi daftar truknya lewat tombol Isi daftar truk.`)}
        />
      ) : null}
    </div>
  );
}

export function DeliveryOrdersScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canView(state.user, "delivery_orders")) return <AccessDenied module="delivery_orders" />;
  return <DeliveryOrdersPage user={state.user} />;
}
