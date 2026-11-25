"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { Loader2, Search } from "lucide-react";

import { ExpiryDate } from "@/components/expiry-date";
import { SelectField, TextField } from "@/components/form-fields";
import { Notice } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatQuantity } from "@/lib/format";
import { LICENCE_CLASSES } from "@/lib/forms";
import { plateError, plateKey } from "@/lib/plate";
import { api } from "@/lib/session";
import { expirySummary, registryStatusInfo } from "@/lib/status";
import type { LookupDriver, LookupVehicle, VehicleType } from "@/lib/types";
import {
  currentLookup,
  isBlacklisted,
  licenceKey,
  needsContainer,
  type FormErrors,
  type TruckValues,
} from "@/lib/workflow-forms";

type Update = (update: (truck: TruckValues) => TruckValues) => void;

/**
 * Looks a plate up with GET /api/lookup/vehicle, which finds one vehicle by
 * its whole plate for any account that may register. The answer is kept only
 * if the plate did not change meanwhile.
 */
export async function lookUpVehicle(truck: TruckValues, update: Update) {
  const key = plateKey(truck.plate);
  if (plateError(truck.plate)) return;
  const current = currentLookup(truck.vehicle, key);
  if (current.state === "found" || current.state === "missing" || current.state === "loading") return;
  update((t) => ({ ...t, vehicle: { state: "loading", key } }));
  try {
    const { vehicle: match } = await api.request<{ vehicle: LookupVehicle | null }>("/api/lookup/vehicle", { query: { plate: key } });
    update((t) =>
      plateKey(t.plate) === key
        ? { ...t, vehicle: match ? { state: "found", key, item: match } : { state: "missing", key } }
        : t,
    );
  } catch {
    update((t) => (plateKey(t.plate) === key ? { ...t, vehicle: { state: "failed", key } } : t));
  }
}

/** GET /api/lookup/driver: one driver by its whole licence number. */
export async function lookUpDriver(truck: TruckValues, update: Update) {
  const key = licenceKey(truck.licenceNo);
  if (!key) return;
  const current = currentLookup(truck.driver, key);
  if (current.state === "found" || current.state === "missing" || current.state === "loading") return;
  update((t) => ({ ...t, driver: { state: "loading", key } }));
  try {
    const { driver: match } = await api.request<{ driver: LookupDriver | null }>("/api/lookup/driver", { query: { licenceNo: key } });
    update((t) =>
      licenceKey(t.licenceNo) === key
        ? { ...t, driver: match ? { state: "found", key, item: match } : { state: "missing", key } }
        : t,
    );
  } catch {
    update((t) => (licenceKey(t.licenceNo) === key ? { ...t, driver: { state: "failed", key } } : t));
  }
}

/** A text box with a "Periksa" button; Enter and leaving the box also start the lookup. */
function LookupField({
  label,
  name,
  value,
  onChange,
  onLookUp,
  busy,
  error,
  hint,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  onLookUp: () => void;
  busy: boolean;
  error?: string;
  hint?: string;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // Enter looks the value up instead of submitting the whole form.
      event.preventDefault();
      onLookUp();
    }
  }
  return (
    <div className="flex items-start gap-2">
      <TextField
        label={label}
        name={name}
        value={value}
        onChange={onChange}
        onBlur={onLookUp}
        onKeyDown={handleKeyDown}
        error={error}
        hint={hint}
        autoCapitalize="characters"
        spellCheck={false}
        enterKeyHint="search"
        className="min-w-0 flex-1 [&_input]:uppercase"
      />
      <Button type="button" variant="outline" className="mt-5.5 shrink-0" onClick={onLookUp} aria-label={`Periksa ${label.toLowerCase()}`}>
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
        Periksa
      </Button>
    </div>
  );
}

function Found({ children }: { children: ReactNode }) {
  return <div className="rounded-md border bg-muted/40 px-3 py-2.5 text-sm">{children}</div>;
}

export function TruckFields({
  truck,
  update,
  errors,
  prefix,
  types,
  showHandover = false,
  outgoingExtras = false,
}: {
  truck: TruckValues;
  update: Update;
  errors: FormErrors;
  /** Path of this truck in the form ("truck", "trucks.2"): names the inputs and picks the errors. */
  prefix: string;
  types: readonly VehicleType[];
  showHandover?: boolean;
  /** The two free texts of an outgoing truck: SPBE tambahan, passport or travel letter. */
  outgoingExtras?: boolean;
}) {
  const error = (field: string) => errors[`${prefix}.${field}`];
  const set = <K extends keyof TruckValues>(field: K, value: TruckValues[K]) => update((t) => ({ ...t, [field]: value }));
  const vehicle = currentLookup(truck.vehicle, plateKey(truck.plate));
  const driver = currentLookup(truck.driver, licenceKey(truck.licenceNo));
  const typeName = (code: string | null) => (code ? (types.find((type) => type.code === code)?.name ?? code) : "Jenis belum diisi");

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">Kendaraan</legend>
        <LookupField
          label="Plat"
          name={`${prefix}.plate`}
          value={truck.plate}
          onChange={(value) => set("plate", value)}
          onLookUp={() => void lookUpVehicle(truck, update)}
          busy={vehicle.state === "loading"}
          error={error("plate")}
          hint={vehicle.state === "idle" ? "Ketik plat lalu tekan Periksa. Kendaraan yang sudah terdaftar terisi sendiri." : undefined}
        />
        <div aria-live="polite" className="empty:hidden">
          {vehicle.state === "found" ? (
            <Found>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{vehicle.item.plateDisplay}</span>
                <span className="text-muted-foreground">{typeName(vehicle.item.vehicleTypeCode)}</span>
                {vehicle.item.verified ? null : <StatusBadge info={{ label: "Belum diverifikasi", tone: "warning" }} />}
                {vehicle.item.isActive ? null : <StatusBadge info={{ label: "Nonaktif", tone: "destructive" }} />}
              </p>
              <p className="mt-1 text-muted-foreground">
                {[vehicle.item.owner?.name, vehicle.item.capacityKg ? `Daya angkut ${formatQuantity(vehicle.item.capacityKg, "kg")}` : null]
                  .filter(Boolean)
                  .join(" · ") || "Pemilik belum tercatat"}
              </p>
              <p className="mt-1">
                Surat kendaraan: {expirySummary(vehicle.item.expired) ?? "STNK, pajak, dan KIR masih berlaku"}.
              </p>
            </Found>
          ) : vehicle.state === "missing" ? (
            <Notice tone="warning">
              Plat ini belum terdaftar. Isi data kendaraan di bawah; kendaraan baru ditinjau admin logistik.
            </Notice>
          ) : vehicle.state === "failed" ? (
            <Notice tone="error">Plat belum bisa diperiksa. Tekan Periksa lagi.</Notice>
          ) : null}
        </div>
        {vehicle.state === "missing" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Jenis kendaraan"
              name={`${prefix}.vehicleTypeCode`}
              value={truck.vehicleTypeCode}
              onChange={(value) => set("vehicleTypeCode", value)}
              error={error("vehicleTypeCode")}
              emptyLabel="Pilih jenis"
              options={types.map((type) => ({ value: type.code, label: type.name }))}
            />
            <TextField
              label="Daya angkut (kg)"
              name={`${prefix}.capacityKg`}
              inputMode="numeric"
              optional
              value={truck.capacityKg}
              onChange={(value) => set("capacityKg", value)}
              error={error("capacityKg")}
            />
            <TextField
              label="Tahun produksi"
              name={`${prefix}.productionYear`}
              inputMode="numeric"
              optional
              value={truck.productionYear}
              onChange={(value) => set("productionYear", value)}
              error={error("productionYear")}
            />
            <TextField
              label="Tarra (kg)"
              name={`${prefix}.tareKg`}
              inputMode="numeric"
              optional
              value={truck.tareKg}
              onChange={(value) => set("tareKg", value)}
              error={error("tareKg")}
            />
            <TextField
              label="STNK berlaku sampai"
              name={`${prefix}.stnkValidUntil`}
              type="date"
              optional
              value={truck.stnkValidUntil}
              onChange={(value) => set("stnkValidUntil", value)}
            />
            <TextField
              label="Pajak berlaku sampai"
              name={`${prefix}.taxValidUntil`}
              type="date"
              optional
              value={truck.taxValidUntil}
              onChange={(value) => set("taxValidUntil", value)}
            />
            <TextField
              label="KIR berlaku sampai"
              name={`${prefix}.kirValidUntil`}
              type="date"
              optional
              value={truck.kirValidUntil}
              onChange={(value) => set("kirValidUntil", value)}
            />
          </div>
        ) : null}
        {needsContainer(truck, types) ? (
          <TextField
            label="Nomor kontainer"
            name={`${prefix}.containerNo`}
            value={truck.containerNo}
            onChange={(value) => set("containerNo", value)}
            error={error("containerNo")}
            hint="Jenis kendaraan ini wajib menyebut nomor kontainer."
            autoCapitalize="characters"
            className="[&_input]:uppercase"
          />
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">Supir</legend>
        <LookupField
          label="Nomor SIM"
          name={`${prefix}.licenceNo`}
          value={truck.licenceNo}
          onChange={(value) => set("licenceNo", value)}
          onLookUp={() => void lookUpDriver(truck, update)}
          busy={driver.state === "loading"}
          error={error("licenceNo")}
          hint={driver.state === "idle" ? "Ketik nomor SIM lalu tekan Periksa. Supir yang sudah terdaftar terisi sendiri." : undefined}
        />
        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
          {driver.state === "found" ? (
            <>
              <Found>
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{driver.item.fullName}</span>
                  <StatusBadge info={registryStatusInfo(driver.item.registryStatus)} />
                </p>
                <p className="mt-1 text-muted-foreground">
                  SIM {driver.item.licenceClass ?? "-"}, berlaku sampai{" "}
                  <ExpiryDate value={driver.item.licenceValidUntil} expired={driver.item.licenceExpired} />
                </p>
              </Found>
              {isBlacklisted(driver.item) ? (
                <Notice tone="error">Supir ini masuk daftar hitam VCF dan tidak bisa didaftarkan. Ganti supirnya.</Notice>
              ) : driver.item.blocked ? (
                <Notice tone="error">Supir ini sedang diblokir di pabrik dan tidak bisa didaftarkan. Ganti supirnya.</Notice>
              ) : !driver.item.isActive ? (
                <Notice tone="error">Supir ini tidak aktif. Hubungi admin logistik.</Notice>
              ) : driver.item.registryStatus?.toUpperCase() === "WARNING" ? (
                <Notice tone="warning">
                  Supir ini berstatus Warning di VCF. Registrasi tetap bisa dikirim, tetapi ditinjau admin logistik dulu.
                </Notice>
              ) : null}
            </>
          ) : driver.state === "missing" ? (
            <Notice tone="warning">
              Nomor SIM ini belum terdaftar. Isi data supir di bawah; supir baru dikirim ke VCF dan registrasinya ditinjau admin logistik.
            </Notice>
          ) : driver.state === "failed" ? (
            <Notice tone="error">Nomor SIM belum bisa diperiksa. Tekan Periksa lagi.</Notice>
          ) : null}
        </div>
        {driver.state === "missing" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Nama supir"
              name={`${prefix}.fullName`}
              value={truck.fullName}
              onChange={(value) => set("fullName", value)}
              error={error("fullName")}
              autoComplete="name"
            />
            <SelectField
              label="Jenis SIM"
              name={`${prefix}.licenceClass`}
              value={truck.licenceClass}
              onChange={(value) => set("licenceClass", value)}
              error={error("licenceClass")}
              emptyLabel="Pilih jenis SIM"
              options={LICENCE_CLASSES.map((value) => ({ value, label: value }))}
            />
            <TextField
              label="SIM berlaku sampai"
              name={`${prefix}.licenceValidUntil`}
              type="date"
              value={truck.licenceValidUntil}
              onChange={(value) => set("licenceValidUntil", value)}
              error={error("licenceValidUntil")}
            />
            <TextField
              label="Telepon"
              name={`${prefix}.phone`}
              type="tel"
              inputMode="tel"
              optional
              value={truck.phone}
              onChange={(value) => set("phone", value)}
              error={error("phone")}
            />
          </div>
        ) : null}
      </fieldset>

      {showHandover ? (
        <TextField
          label="Nomor penyerahan"
          name={`${prefix}.handoverNo`}
          optional
          value={truck.handoverNo}
          onChange={(value) => set("handoverNo", value)}
        />
      ) : null}

      {outgoingExtras ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="SPBE tambahan"
            name={`${prefix}.extraSpbe`}
            optional
            maxLength={200}
            value={truck.extraSpbe}
            onChange={(value) => set("extraSpbe", value)}
            error={error("extraSpbe")}
            hint="Isi bila ada."
          />
          <TextField
            label="Passport atau surat jalan"
            name={`${prefix}.passportNo`}
            optional
            maxLength={200}
            value={truck.passportNo}
            onChange={(value) => set("passportNo", value)}
            error={error("passportNo")}
            hint="Nomor passport atau surat jalan, bila ada."
          />
        </div>
      ) : null}
    </div>
  );
}
