"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, X } from "lucide-react";

import { SelectField, TextAreaField, TextField } from "@/components/form-fields";
import { ListError, ListSkeleton, Notice, PageHeader } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { dropErrors, FormSection, SubmitBar, focusFirstInvalid } from "@/features/registrations/form-parts";
import { plantToday } from "@/features/registrations/incoming-form";
import { lookUpDriver, lookUpVehicle, TruckFields } from "@/features/registrations/truck-fields";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate, formatNumber, formatQuantity } from "@/lib/format";
import { isApiError } from "@/lib/api-client";
import { registrationErrorMessage } from "@/lib/messages";
import { planPerTruck, wholeKg } from "@/lib/quantity";
import { api } from "@/lib/session";
import { changeQuery } from "@/lib/registration-changes";
import type { DeliveryOrder, DeliveryOrderDetail, Page, Registration, SpjChange, VehicleType } from "@/lib/types";
import {
  emptyTruck,
  outgoingFromDraft,
  outgoingPayload,
  registrationFieldErrors,
  validateOutgoing,
  type FormErrors,
  type OutgoingValues,
  type TruckValues,
} from "@/lib/workflow-forms";

/** Trucks the form starts with when the delivery order names no count. Larger counts are added by hand. */
const MAX_INITIAL_TRUCKS = 12;

let truckSerial = 0;
const newTruck = () => emptyTruck(`truck-${(truckSerial += 1)}`);

const remainingText = (order: DeliveryOrder) => (order.qtyRemaining > 0 ? String(Math.floor(order.qtyRemaining)) : "");

function OutgoingFormBody({
  initialOrder,
  types,
  draft,
  draftOrders,
}: {
  initialOrder: DeliveryOrder | null;
  types: VehicleType[];
  /** A draft to change with PUT, and the delivery orders it names. */
  draft: Registration | null;
  draftOrders: DeliveryOrder[];
}) {
  const router = useRouter();
  // a registration already sent: trucks that checked in stay out of the form, and with them the DOs are fixed
  const sent = draft !== null && draft.status.toUpperCase() !== "DRAFT";
  const lockedTrips = sent ? draft.trips.filter((trip) => trip.edit && !trip.edit.allowed && !["CANCELLED", "EXPIRED"].includes(trip.status.toUpperCase())) : [];
  const ordersFixed = sent && draft.edit?.allocationsLocked === true;
  const [initial] = useState(() => (draft ? outgoingFromDraft(draft, draftOrders) : null));
  const [orders, setOrders] = useState<OutgoingValues["orders"]>(
    initial?.orders ?? (initialOrder ? [{ order: initialOrder, qty: remainingText(initialOrder) }] : []),
  );
  const [trucks, setTrucks] = useState<TruckValues[]>(
    () =>
      initial?.trucks ??
      Array.from({ length: Math.min(Math.max(initialOrder?.truckCount ?? 1, 1), MAX_INITIAL_TRUCKS) }, newTruck),
  );
  const [plannedDate, setPlannedDate] = useState(initial?.plannedDate || plantToday());
  const [remark, setRemark] = useState(initial?.remark ?? "");
  const [addOrderId, setAddOrderId] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<"draft" | "submit" | null>(null);

  const accepted = useApiQuery("accepted-orders", (signal) =>
    api.request<Page<DeliveryOrder>>("/api/delivery-orders", { query: { status: "ACCEPTED", limit: 50 }, signal }),
  );
  // Every order of one registration runs for the same transporter.
  const transporterId = orders[0]?.order.transporter?.id;
  const addable = (accepted.data?.items ?? []).filter(
    (order) =>
      !orders.some((entry) => String(entry.order.id) === String(order.id)) &&
      (transporterId === undefined || String(order.transporter?.id) === String(transporterId)),
  );

  const plan = planPerTruck(
    orders.map((entry) => ({ qty: wholeKg(entry.qty) })),
    trucks.length,
  );

  function updateTruck(key: string, change: (truck: TruckValues) => TruckValues) {
    setTrucks((current) => current.map((truck) => (truck.key === key ? change(truck) : truck)));
    const index = trucks.findIndex((truck) => truck.key === key);
    setErrors((current) => dropErrors(current, `trucks.${index}.`));
  }

  // The trucks of a draft come back with plate and licence; each is looked up again once.
  const lookedUp = useRef(false);
  useEffect(() => {
    if (!initial || lookedUp.current) return;
    lookedUp.current = true;
    for (const truck of initial.trucks) {
      const update = (change: (value: TruckValues) => TruckValues) =>
        setTrucks((current) => current.map((item) => (item.key === truck.key ? change(item) : item)));
      void lookUpVehicle(truck, update);
      void lookUpDriver(truck, update);
    }
  }, [initial]);

  async function save(submit: boolean) {
    const values: OutgoingValues = { orders, trucks, plannedDate, remark };
    const found = validateOutgoing(values, { types, parameters: [], currentYear: new Date().getFullYear() });
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      setFormError("Periksa kolom yang ditandai.");
      focusFirstInvalid();
      return;
    }
    setPending(submit ? "submit" : "draft");
    try {
      const { registration, spjChanges } = await api.request<{ registration: Registration; spjChanges?: SpjChange[] }>(
        draft ? `/api/registrations/${encodeURIComponent(String(draft.id))}` : "/api/registrations",
        { method: draft ? "PUT" : "POST", body: outgoingPayload(values, submit) },
      );
      const id = encodeURIComponent(String(registration.id));
      router.push(sent ? `/registrasi/${id}?${changeQuery(spjChanges ?? [])}` : `/registrasi/${id}?baru=${submit ? "kirim" : "draf"}`);
    } catch (error) {
      const placed = isApiError(error) ? registrationFieldErrors("OUT", error.fieldMessages) : { errors: {}, unplaced: [] };
      setErrors(placed.errors);
      setFormError(registrationErrorMessage(error, placed.unplaced));
      setPending(null);
      if (Object.keys(placed.errors).length > 0) focusFirstInvalid();
    }
  }

  return (
    <form noValidate onSubmit={(event) => event.preventDefault()} className="flex flex-col gap-5">
      <PageHeader
        title={draft ? (sent ? `Ubah ${draft.regNo}` : `Ubah draf ${draft.regNo}`) : "Registrasi outgoing"}
        description="Daftar truk untuk delivery order yang sudah diterima. Quantity tiap DO dibagi rata ke semua truk. Close cargo dan flexi bag ditandai petugas pos saat truk check-in."
      />

      {sent ? (
        <div data-testid="sent-edit-notice">
          <Notice tone="warning">
            Registrasi ini sudah dikirim. Truk yang plat, kendaraan, atau supirnya diganti mendapat SPJ baru yang harus dicetak lagi.
            {lockedTrips.length > 0
              ? ` Truk ${lockedTrips.map((trip) => `${trip.seq} (${trip.vehicle?.plateDisplay ?? "-"})`).join(", ")} sudah check-in di pos, jadi tidak ikut diubah, dan DO tidak bisa diganti.`
              : ""}
          </Notice>
        </div>
      ) : null}
      <FormSection title="1. Delivery order">
        {orders.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada DO yang dipilih.</p> : null}
        <ul className="flex flex-col gap-3">
          {orders.map((entry, index) => {
            const shares = plan.perOrder[index] ?? [];
            const first = shares[0];
            const last = shares[shares.length - 1];
            return (
              <li key={entry.order.id} className="rounded-md border p-3 text-sm sm:p-4" data-order={entry.order.doNo}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{entry.order.doNo}</p>
                    <p className="text-xs wrap-break-word text-muted-foreground">
                      {[entry.order.partner?.name, entry.order.product?.name, entry.order.destination?.name].filter(Boolean).join(" · ")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Sisa {formatQuantity(entry.order.qtyRemaining, entry.order.uom)} dari {formatQuantity(entry.order.qty, entry.order.uom)} ·
                      kirim {formatDate(entry.order.deliveryFrom)}
                      {entry.order.deliveryUntil ? ` sampai ${formatDate(entry.order.deliveryUntil)}` : ""}
                    </p>
                  </div>
                  {ordersFixed ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Hapus DO ${entry.order.doNo}`}
                      onClick={() => setOrders((current) => current.filter((_, at) => at !== index))}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  )}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end">
                  <TextField
                    label={lockedTrips.length > 0 ? "Quantity untuk truk yang belum check-in (kg)" : "Quantity untuk registrasi ini (kg)"}
                    name={`orders.${index}.qty`}
                    inputMode="numeric"
                    value={entry.qty}
                    onChange={(value) => {
                      setOrders((current) => current.map((item, at) => (at === index ? { ...item, qty: value } : item)));
                      setErrors((current) => dropErrors(current, `orders.${index}.`));
                    }}
                    error={errors[`orders.${index}.qty`]}
                  />
                  <p className="text-sm sm:pb-2.5" data-testid="split-summary">
                    {first === undefined
                      ? "Tambahkan truk untuk melihat pembagiannya."
                      : shares.length === 1 || first === last
                        ? `${formatNumber(first)} kg per truk untuk ${formatNumber(shares.length)} truk.`
                        : `${formatNumber(first)} kg per truk, truk terakhir ${formatNumber(last)} kg.`}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        {errors.orders ? <p className="text-sm text-destructive">{errors.orders}</p> : null}
        {addable.length > 0 && !ordersFixed ? (
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label={orders.length === 0 ? "Pilih DO" : "Tambah DO lain"}
              name="addOrder"
              value={addOrderId}
              onChange={setAddOrderId}
              emptyLabel="Pilih DO yang sudah diterima"
              options={addable.map((order) => ({
                value: String(order.id),
                label: `${order.doNo} · ${order.partner?.name ?? "-"} · sisa ${formatQuantity(order.qtyRemaining, order.uom)}`,
              }))}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!addOrderId}
              onClick={() => {
                const order = addable.find((item) => String(item.id) === addOrderId);
                if (!order) return;
                setOrders((current) => [...current, { order, qty: remainingText(order) }]);
                setAddOrderId("");
                setErrors((current) => dropErrors(current, "orders"));
              }}
            >
              <Plus aria-hidden="true" />
              Tambah
            </Button>
          </div>
        ) : accepted.hasError ? (
          <p className="text-sm text-destructive">Daftar DO yang sudah diterima belum bisa dimuat.</p>
        ) : null}
      </FormSection>

      <FormSection title="2. Tanggal datang">
        <TextField
          label="Tanggal datang"
          name="plannedDate"
          type="date"
          value={plannedDate}
          onChange={setPlannedDate}
          error={errors.plannedDate}
          className="sm:max-w-xs"
        />
      </FormSection>

      <section aria-labelledby="trucks-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="trucks-heading" className="text-base font-semibold">
            3. Daftar truk ({formatNumber(trucks.length)})
          </h2>
        </div>
        {errors.trucks ? <p className="text-sm text-destructive">{errors.trucks}</p> : null}
        <ol className="flex flex-col gap-3">
          {trucks.map((truck, index) => (
            <li key={truck.key} className="rounded-2xl border bg-card p-4 sm:p-5" data-truck={index + 1}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  Truk {index + 1}
                  <span className="ml-2 font-normal text-muted-foreground" data-testid="truck-plan">
                    Rencana {formatQuantity(plan.perTruck[index] ?? 0, "kg")}
                  </span>
                </h3>
                {trucks.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-10 md:h-8"
                    aria-label={`Hapus truk ${index + 1}`}
                    onClick={() => {
                      setTrucks((current) => current.filter((item) => item.key !== truck.key));
                      setErrors((current) => dropErrors(current, "trucks"));
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    Hapus
                  </Button>
                ) : null}
              </div>
              <TruckFields
                truck={truck}
                update={(change) => updateTruck(truck.key, change)}
                errors={errors}
                prefix={`trucks.${index}`}
                types={types}
                showHandover
                outgoingExtras
              />
            </li>
          ))}
        </ol>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => {
            setTrucks((current) => [...current, newTruck()]);
            setErrors((current) => dropErrors(current, "trucks"));
          }}
        >
          <Plus aria-hidden="true" />
          Tambah truk
        </Button>
      </section>

      <FormSection title="4. Catatan">
        <TextAreaField label="Catatan" name="remark" optional rows={2} value={remark} onChange={setRemark} />
      </FormSection>

      <SubmitBar pending={pending} error={formError} onDraft={() => void save(false)} onSubmit={() => void save(true)} sent={sent} />
    </form>
  );
}

const orderPath = (id: string | number) => `/api/delivery-orders/${encodeURIComponent(String(id))}`;

/**
 * Loads the vehicle types and the delivery order named in the address (or,
 * for a draft, every DO it names), then opens the form.
 */
export function OutgoingForm({ orderId, draft = null }: { orderId: string | null; draft?: Registration | null }) {
  const draftOrderIds = (draft?.allocations ?? []).flatMap((allocation) => (allocation.deliveryOrder ? [allocation.deliveryOrder.id] : []));
  const types = useApiQuery("vehicle-types", (signal) => api.request<{ items: VehicleType[] }>("/api/vehicle-types", { signal }));
  const order = useApiQuery(orderId && !draft ? `order|${orderId}` : null, (signal) =>
    api.request<DeliveryOrderDetail>(orderPath(orderId ?? ""), { signal }),
  );
  const draftOrders = useApiQuery(draft ? `draft-orders|${draftOrderIds.join(",")}` : null, (signal) =>
    Promise.all(draftOrderIds.map((id) => api.request<DeliveryOrderDetail>(orderPath(id), { signal }))),
  );
  const failure = types.hasError ? types.error : order.hasError ? order.error : draftOrders.hasError ? draftOrders.error : null;
  if (failure) {
    return (
      <ListError
        title="Form registrasi belum bisa dibuka"
        error={failure}
        onRetry={() => {
          types.reload();
          order.reload();
          draftOrders.reload();
        }}
      />
    );
  }
  if (!types.data || (orderId && !draft && !order.data) || (draft && !draftOrders.data)) {
    return <ListSkeleton label="Menyiapkan form registrasi" />;
  }
  const initial = order.data?.deliveryOrder ?? null;
  return (
    <OutgoingFormBody
      key={draft ? `draft-${draft.id}` : (orderId ?? "none")}
      initialOrder={initial && initial.status.toUpperCase() === "ACCEPTED" ? initial : null}
      types={types.data.items}
      draft={draft}
      draftOrders={(draftOrders.data ?? []).map((detail) => detail.deliveryOrder)}
    />
  );
}
