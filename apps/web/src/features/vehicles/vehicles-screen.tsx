"use client";

import { useId, useMemo, useState } from "react";
import { Pencil, Plus } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { ExpiryDate } from "@/components/expiry-date";
import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, Notice, PageHeader, ResultCount, SearchField } from "@/components/page-parts";
import { PartnerLookup } from "@/components/partner-lookup";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { refusedFields, useAction, useFormValues } from "@/hooks/use-form";
import { formatQuantity } from "@/lib/format";
import { EMPTY_VEHICLE, tareChanged, validateVehicle, vehiclePayload, type VehicleValues } from "@/lib/forms";
import { saveErrorMessage } from "@/lib/messages";
import { canAddVehicle, canEditVehicle, canView } from "@/lib/permissions";
import { api } from "@/lib/session";
import { expirySummary } from "@/lib/status";
import type { Page, PartnerRef, Vehicle, VehicleType } from "@/lib/types";

const LIST_LIMIT = 50;

const OWNERSHIP_LABELS: Record<string, string> = { SENDIRI: "Milik sendiri", MITRA: "Milik mitra" };

/** Whole kilograms as the form holds them; the API may send "5000.000". */
function wholeText(value: number | string | null): string {
  if (value === null || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(Math.round(parsed)) : "";
}

function toValues(vehicle: Vehicle): VehicleValues {
  return {
    plateDisplay: vehicle.plateDisplay,
    vehicleTypeCode: vehicle.vehicleTypeCode ?? "",
    ownerPartnerId: vehicle.owner ? String(vehicle.owner.id) : "",
    ownership: vehicle.ownership ?? "",
    capacityKg: wholeText(vehicle.capacityKg),
    productionYear: vehicle.productionYear === null ? "" : String(vehicle.productionYear),
    tareKg: wholeText(vehicle.tareKg),
    tareReason: "",
    stnkValidUntil: vehicle.stnkValidUntil ?? "",
    taxValidUntil: vehicle.taxValidUntil ?? "",
    kirValidUntil: vehicle.kirValidUntil ?? "",
    isActive: vehicle.isActive,
  };
}

function VehicleFormSheet({
  vehicle,
  types,
  onClose,
  onSaved,
}: {
  /** The vehicle being edited, or null for a new one. */
  vehicle: Vehicle | null;
  types: VehicleType[];
  onClose: () => void;
  onSaved: (vehicle: Vehicle, created: boolean) => void;
}) {
  const form = useFormValues<VehicleValues>(vehicle ? toValues(vehicle) : EMPTY_VEHICLE);
  const [owner, setOwner] = useState<PartnerRef | null>(vehicle?.owner ?? null);
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();

  const original = vehicle ? { tareKg: vehicle.tareKg } : null;
  const showTareReason = tareChanged(form.values, original);

  async function handleSubmit() {
    const errors = validateVehicle(form.values, original, new Date().getFullYear());
    form.setErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    const body = vehiclePayload(form.values, original);
    const outcome = await save.run(() =>
      vehicle
        ? api.request<{ vehicle: Vehicle }>(`/api/vehicles/${encodeURIComponent(String(vehicle.id))}`, {
            method: "PATCH",
            body,
          })
        : api.request<{ vehicle: Vehicle }>("/api/vehicles", { method: "POST", body }),
    );
    if (outcome.ok) {
      onSaved(outcome.value.vehicle, vehicle === null);
    } else {
      const refused = refusedFields<VehicleValues>(outcome.error);
      form.setErrors(refused);
      setFormError(saveErrorMessage(outcome.error, "Plat ini sudah terdaftar."));
    }
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={vehicle ? `Ubah ${vehicle.plateDisplay}` : "Kendaraan baru"}
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      <TextField
        label="Plat"
        name="plateDisplay"
        value={form.values.plateDisplay}
        onChange={(value) => form.set("plateDisplay", value)}
        error={form.errors.plateDisplay}
        hint="3 sampai 12 huruf dan angka. Spasi boleh dipakai."
        autoCapitalize="characters"
        spellCheck={false}
        className="[&_input]:uppercase"
      />
      <SelectField
        label="Jenis"
        name="vehicleTypeCode"
        optional
        value={form.values.vehicleTypeCode}
        onChange={(value) => form.set("vehicleTypeCode", value)}
        error={form.errors.vehicleTypeCode}
        emptyLabel="Belum ditentukan"
        options={types.map((type) => ({ value: type.code, label: type.name }))}
      />
      <PartnerLookup
        role="transporter"
        label="Pemilik"
        name="ownerLookup"
        placeholder="Cari nama transporter"
        optional
        value={owner}
        onChange={(partner) => {
          setOwner(partner);
          form.set("ownerPartnerId", partner ? String(partner.id) : "");
        }}
        error={form.errors.ownerPartnerId}
      />
      <SelectField
        label="Kepemilikan"
        name="ownership"
        optional
        value={form.values.ownership}
        onChange={(value) => form.set("ownership", value)}
        error={form.errors.ownership}
        emptyLabel="Belum ditentukan"
        options={Object.entries(OWNERSHIP_LABELS).map(([value, label]) => ({ value, label }))}
      />
      <div className="grid grid-cols-2 gap-4">
        <TextField
          label="Daya angkut (Kg)"
          name="capacityKg"
          inputMode="numeric"
          optional
          value={form.values.capacityKg}
          onChange={(value) => form.set("capacityKg", value)}
          error={form.errors.capacityKg}
        />
        <TextField
          label="Tahun produksi"
          name="productionYear"
          inputMode="numeric"
          optional
          value={form.values.productionYear}
          onChange={(value) => form.set("productionYear", value)}
          error={form.errors.productionYear}
        />
      </div>
      <TextField
        label="Tarra (Kg)"
        name="tareKg"
        inputMode="numeric"
        optional
        value={form.values.tareKg}
        onChange={(value) => form.set("tareKg", value)}
        error={form.errors.tareKg}
      />
      {showTareReason ? (
        <TextAreaField
          label="Alasan perubahan tarra"
          name="tareReason"
          rows={2}
          value={form.values.tareReason}
          onChange={(value) => form.set("tareReason", value)}
          error={form.errors.tareReason}
        />
      ) : null}
      <TextField
        label="STNK berlaku sampai"
        name="stnkValidUntil"
        type="date"
        optional
        value={form.values.stnkValidUntil}
        onChange={(value) => form.set("stnkValidUntil", value)}
        error={form.errors.stnkValidUntil}
      />
      <TextField
        label="Pajak berlaku sampai"
        name="taxValidUntil"
        type="date"
        optional
        value={form.values.taxValidUntil}
        onChange={(value) => form.set("taxValidUntil", value)}
        error={form.errors.taxValidUntil}
      />
      <TextField
        label="KIR berlaku sampai"
        name="kirValidUntil"
        type="date"
        optional
        value={form.values.kirValidUntil}
        onChange={(value) => form.set("kirValidUntil", value)}
        error={form.errors.kirValidUntil}
      />
      {vehicle ? (
        <CheckboxField
          label="Aktif"
          description="Kendaraan nonaktif tetap tersimpan."
          name="isActive"
          checked={form.values.isActive}
          onChange={(checked) => form.set("isActive", checked)}
        />
      ) : null}
    </FormSheet>
  );
}

export function VehiclesScreen() {
  const { state } = useAuth();
  const user = state.status === "authenticated" ? state.user : null;
  const mayView = canView(user, "vehicles");
  const mayAdd = canAddVehicle(user);
  const mayEdit = canEditVehicle(user);

  const ids = useId();
  const [searchText, setSearchText] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  // undefined: sheet closed, null: new vehicle, otherwise the vehicle being edited
  const [editing, setEditing] = useState<Vehicle | null | undefined>(undefined);

  const search = useDebouncedValue(searchText.trim(), 300);

  const types = useApiQuery(mayView ? "vehicle-types" : null, (signal) =>
    api.request<{ items: VehicleType[] }>("/api/vehicle-types", { signal }),
  );
  const list = useApiQuery(
    mayView ? `${search}|${reloadToken}` : null,
    (signal) => api.request<Page<Vehicle>>("/api/vehicles", { query: { q: search, limit: LIST_LIMIT }, signal }),
    { keepPrevious: true },
  );

  const typeItems = types.data?.items;
  const columns = useMemo<ReadonlyArray<Column<Vehicle>>>(() => {
    const typeNames = new Map((typeItems ?? []).map((type) => [type.code, type.name]));
    const isExpired = (vehicle: Vehicle, code: string) => vehicle.expired.includes(code);
    return [
      {
        id: "plate",
        header: "Plat",
        primary: true,
        cell: (vehicle) => {
          const summary = expirySummary(vehicle.expired);
          return (
            <>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium whitespace-nowrap">{vehicle.plateDisplay}</span>
                {vehicle.isActive ? null : <StatusBadge info={{ label: "Nonaktif", tone: "neutral" }} />}
              </span>
              {summary ? <span className="block text-xs font-medium text-destructive">{summary}</span> : null}
            </>
          );
        },
      },
      {
        id: "type",
        header: "Jenis",
        cell: (vehicle) =>
          vehicle.vehicleTypeCode ? (typeNames.get(vehicle.vehicleTypeCode) ?? vehicle.vehicleTypeCode) : "-",
      },
      {
        id: "owner",
        header: "Pemilik",
        cellClassName: "max-w-48",
        cell: (vehicle) => (
          <>
            <span className="block truncate" title={vehicle.owner?.name}>
              {vehicle.owner?.name ?? "-"}
            </span>
            {vehicle.ownership ? (
              <span className="block text-xs text-muted-foreground">
                {OWNERSHIP_LABELS[vehicle.ownership] ?? vehicle.ownership}
              </span>
            ) : null}
          </>
        ),
      },
      {
        id: "capacity",
        header: "Daya angkut",
        align: "right",
        cell: (vehicle) => formatQuantity(vehicle.capacityKg, "Kg"),
      },
      { id: "year", header: "Tahun", cell: (vehicle) => vehicle.productionYear ?? "-" },
      { id: "tare", header: "Tarra", align: "right", cell: (vehicle) => formatQuantity(vehicle.tareKg, "Kg") },
      {
        id: "stnk",
        header: "STNK",
        cell: (vehicle) => <ExpiryDate value={vehicle.stnkValidUntil} expired={isExpired(vehicle, "STNK")} />,
      },
      {
        id: "tax",
        header: "Pajak",
        cell: (vehicle) => <ExpiryDate value={vehicle.taxValidUntil} expired={isExpired(vehicle, "TAX")} />,
      },
      {
        id: "kir",
        header: "KIR",
        cell: (vehicle) => <ExpiryDate value={vehicle.kirValidUntil} expired={isExpired(vehicle, "KIR")} />,
      },
    ];
  }, [typeItems]);

  if (!user) return null;
  if (!mayView) return <AccessDenied module="vehicles" />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Kendaraan" description="Data truk beserta masa berlaku STNK, pajak, dan KIR.">
        {mayAdd ? (
          <Button onClick={() => setEditing(null)}>
            <Plus aria-hidden="true" />
            Kendaraan baru
          </Button>
        ) : null}
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {saved ? <Notice tone="success">{saved}</Notice> : null}
      </div>

      <SearchField
        id={`${ids}-search`}
        label="Cari kendaraan"
        placeholder="Nomor plat"
        value={searchText}
        onChange={setSearchText}
      />

      {list.hasError ? (
        <ListError title="Daftar kendaraan belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar kendaraan" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada kendaraan yang cocok"
          hint={search ? "Periksa lagi nomor plat yang dicari." : "Belum ada kendaraan yang terdaftar."}
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="kendaraan" />
          <DataList
            columns={columns}
            rows={list.data.items}
            rowKey={(vehicle) => vehicle.id}
            stale={list.isStale}
            actions={
              mayEdit
                ? (vehicle) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-10 md:h-8"
                      onClick={() => setEditing(vehicle)}
                      aria-label={`Ubah ${vehicle.plateDisplay}`}
                    >
                      <Pencil aria-hidden="true" />
                      Ubah
                    </Button>
                  )
                : undefined
            }
          />
        </div>
      )}

      {editing !== undefined ? (
        <VehicleFormSheet
          vehicle={editing}
          types={typeItems ?? []}
          onClose={() => setEditing(undefined)}
          onSaved={(vehicle, created) => {
            setEditing(undefined);
            setSaved(`Kendaraan ${vehicle.plateDisplay} ${created ? "ditambahkan" : "diperbarui"}.`);
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}
    </div>
  );
}
