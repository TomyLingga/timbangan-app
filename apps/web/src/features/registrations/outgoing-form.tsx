"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, X } from "lucide-react";

import { SelectField, TextAreaField, TextField } from "@/components/form-fields";
import { ListError, ListSkeleton, PageHeader } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { dropErrors, FormSection, SubmitBar, focusFirstInvalid } from "@/features/registrations/form-parts";
import { plantToday } from "@/features/registrations/incoming-form";
import { TruckFields } from "@/features/registrations/truck-fields";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate, formatNumber, formatQuantity } from "@/lib/format";
import { registrationErrorMessage } from "@/lib/messages";
import { planPerTruck, wholeKg } from "@/lib/quantity";
import { api } from "@/lib/session";
import type { DeliveryOrder, Page, Registration, VehicleType } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  emptyTruck,
  outgoingPayload,
  validateOutgoing,
  type FormErrors,
  type OutgoingValues,
  type TruckValues,
  type YesNo,
} from "@/lib/workflow-forms";

/** Trucks the form starts with when the delivery order names no count. Larger counts are added by hand. */
const MAX_INITIAL_TRUCKS = 12;

let truckSerial = 0;
const newTruck = () => emptyTruck(`truck-${(truckSerial += 1)}`);

const remainingText = (order: DeliveryOrder) => {
  const remaining = Number(order.qtyRemaining ?? order.qty);
  return Number.isFinite(remaining) && remaining > 0 ? String(Math.floor(remaining)) : "";
};

function YesNoField({
  legend,
  name,
  value,
  onChange,
  error,
}: {
  legend: string;
  name: string;
  value: YesNo;
  onChange: (value: YesNo) => void;
  error?: string;
}) {
  return (
    <fieldset aria-invalid={error ? true : undefined} className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex gap-2">
        {(["yes", "no"] as const).map((option) => (
          <label
            key={option}
            className={cn(
              "flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-4 text-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/50 sm:flex-none",
              value === option ? "border-secondary bg-secondary text-secondary-foreground dark:border-primary dark:bg-primary dark:text-primary-foreground" : "bg-background",
              error && value !== option && "border-destructive",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="sr-only"
            />
            {option === "yes" ? "Ya" : "Tidak"}
          </label>
        ))}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </fieldset>
  );
}

function OutgoingFormBody({ initialOrder, types }: { initialOrder: DeliveryOrder | null; types: VehicleType[] }) {
  const router = useRouter();
  const [orders, setOrders] = useState<OutgoingValues["orders"]>(
    initialOrder ? [{ order: initialOrder, qty: remainingText(initialOrder) }] : [],
  );
  const [trucks, setTrucks] = useState<TruckValues[]>(() =>
    Array.from({ length: Math.min(Math.max(initialOrder?.truckCount ?? 1, 1), MAX_INITIAL_TRUCKS) }, newTruck),
  );
  const [closeCargo, setCloseCargo] = useState<YesNo>("");
  const [flexiBag, setFlexiBag] = useState<YesNo>("");
  const [plannedDate, setPlannedDate] = useState(plantToday());
  const [remark, setRemark] = useState("");
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

  async function save(submit: boolean) {
    const values: OutgoingValues = { orders, trucks, closeCargo, flexiBag, plannedDate, remark };
    const found = validateOutgoing(values, { types, parameters: [], currentYear: new Date().getFullYear() }, submit);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      setFormError("Periksa kolom yang ditandai.");
      focusFirstInvalid();
      return;
    }
    setPending(submit ? "submit" : "draft");
    try {
      const { registration } = await api.request<{ registration: Registration }>("/api/registrations", {
        method: "POST",
        body: outgoingPayload(values, submit),
      });
      router.push(`/registrasi/${encodeURIComponent(String(registration.id))}?baru=${submit ? "kirim" : "draf"}`);
    } catch (error) {
      setFormError(registrationErrorMessage(error));
      setPending(null);
    }
  }

  return (
    <form noValidate onSubmit={(event) => event.preventDefault()} className="flex flex-col gap-5">
      <PageHeader
        title="Registrasi outgoing"
        description="Daftar truk untuk delivery order yang sudah diterima. Quantity tiap DO dibagi rata ke semua truk."
      />

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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Hapus DO ${entry.order.doNo}`}
                    onClick={() => setOrders((current) => current.filter((_, at) => at !== index))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end">
                  <TextField
                    label="Quantity untuk registrasi ini (kg)"
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
        {addable.length > 0 ? (
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
        <TextField label="Tanggal datang" name="plannedDate" type="date" value={plannedDate} onChange={setPlannedDate} className="sm:max-w-xs" />
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
            <li key={truck.key} className="rounded-lg border bg-card p-4 sm:p-5" data-truck={index + 1}>
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

      <FormSection title="4. Muatan" description="Wajib dijawab saat registrasi dikirim.">
        <div className="grid gap-4 sm:grid-cols-2">
          <YesNoField
            legend="Close cargo"
            name="closeCargo"
            value={closeCargo}
            onChange={(value) => {
              setCloseCargo(value);
              setErrors((current) => dropErrors(current, "closeCargo"));
            }}
            error={errors.closeCargo}
          />
          <YesNoField
            legend="Flexi bag"
            name="flexiBag"
            value={flexiBag}
            onChange={(value) => {
              setFlexiBag(value);
              setErrors((current) => dropErrors(current, "flexiBag"));
            }}
            error={errors.flexiBag}
          />
        </div>
      </FormSection>

      <FormSection title="5. Catatan">
        <TextAreaField label="Catatan" name="remark" optional rows={2} value={remark} onChange={setRemark} />
      </FormSection>

      <SubmitBar pending={pending} error={formError} onDraft={() => void save(false)} onSubmit={() => void save(true)} />
    </form>
  );
}

/** Loads the vehicle types and the delivery order named in the address, then opens the form. */
export function OutgoingForm({ orderId }: { orderId: string | null }) {
  const types = useApiQuery("vehicle-types", (signal) => api.request<{ items: VehicleType[] }>("/api/vehicle-types", { signal }));
  const order = useApiQuery(orderId ? `order|${orderId}` : null, (signal) =>
    api.request<{ deliveryOrder: DeliveryOrder }>(`/api/delivery-orders/${encodeURIComponent(orderId ?? "")}`, { signal }),
  );
  if (types.hasError || order.hasError) {
    return (
      <ListError
        title="Form registrasi belum bisa dibuka"
        error={types.error ?? order.error}
        onRetry={() => {
          types.reload();
          order.reload();
        }}
      />
    );
  }
  if (!types.data || (orderId && !order.data)) return <ListSkeleton label="Menyiapkan form registrasi" />;
  const initial = order.data?.deliveryOrder ?? null;
  return (
    <OutgoingFormBody
      key={orderId ?? "none"}
      initialOrder={initial && initial.status.toUpperCase() === "ACCEPTED" ? initial : null}
      types={types.data.items}
    />
  );
}
