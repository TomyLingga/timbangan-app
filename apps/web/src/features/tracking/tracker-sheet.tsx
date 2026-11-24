"use client";

import { useState } from "react";

import { EntityLookup } from "@/components/entity-lookup";
import { SelectField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import { useApiQuery } from "@/hooks/use-api-query";
import { useAction } from "@/hooks/use-form";
import { isApiError } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import type { GpsSource, GpsTracker } from "@/lib/gps";
import { errorMessage } from "@/lib/messages";
import { api } from "@/lib/session";
import type { Page, Vehicle } from "@/lib/types";

type VehicleChoice = { id: string | number; plateDisplay: string };

function trackerError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "DUPLICATE") return "Kendaraan ini sudah memakai alat lain, atau nomor alat ini sudah terpasang di kendaraan lain. Lepas alat yang lama dulu.";
    if (error.code === "INVALID_STATE") return "Alat ini sudah dilepas. Muat ulang halaman.";
    if (error.status === 400) return "Periksa lagi kendaraan, sumber, dan nomor alat.";
  }
  return errorMessage(error);
}

/**
 * Attaches a tracker to a vehicle (POST /api/gps/trackers). Opened from a vehicle, it first shows the tracker the
 * vehicle already has and offers to detach it. `deviceId` and `sourceId` come from an unknown device of a source.
 */
export function TrackerSheet({
  vehicle,
  sourceId,
  deviceId,
  onClose,
  onDone,
}: {
  vehicle?: VehicleChoice | null;
  sourceId?: string | number | null;
  deviceId?: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [chosen, setChosen] = useState<VehicleChoice | null>(vehicle ?? null);
  const [source, setSource] = useState(sourceId ? String(sourceId) : "");
  const [device, setDevice] = useState(deviceId ?? "");
  const [errors, setErrors] = useState<{ vehicle?: string; source?: string; device?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const save = useAction();

  const sources = useApiQuery("gps-sources", (signal) => api.request<{ items: GpsSource[] }>("/api/gps/sources", { signal }));
  const current = useApiQuery(vehicle ? `trackers|${vehicle.id}` : null, (signal) =>
    api.request<{ items: GpsTracker[] }>("/api/gps/trackers", { query: { vehicleId: String(vehicle?.id ?? "") }, signal }),
  );
  const attached = current.data?.items.find((tracker) => tracker.isActive) ?? null;
  const activeSources = (sources.data?.items ?? []).filter((item) => item.isActive);

  async function handleSubmit() {
    setFailure(null);
    if (attached) {
      const outcome = await save.run(() => api.request(`/api/gps/trackers/${encodeURIComponent(String(attached.id))}/detach`, { method: "POST" }));
      if (outcome.ok) onDone(`Alat ${attached.deviceId} dilepas dari ${attached.vehicle.plateDisplay}.`);
      else setFailure(trackerError(outcome.error));
      return;
    }
    const found = {
      vehicle: chosen ? undefined : "Pilih kendaraan.",
      source: source ? undefined : "Pilih sumber posisi.",
      device: device.trim() ? (device.trim().length > 64 ? "Nomor alat paling panjang 64 karakter." : undefined) : "Isi nomor alat seperti yang dipakai penyedia.",
    };
    setErrors(found);
    if (found.vehicle || found.source || found.device || !chosen) return;
    const outcome = await save.run(() =>
      api.request<{ tracker: GpsTracker }>("/api/gps/trackers", {
        method: "POST",
        body: { vehicleId: Number.isNaN(Number(chosen.id)) ? chosen.id : Number(chosen.id), sourceId: Number.isNaN(Number(source)) ? source : Number(source), deviceId: device.trim() },
      }),
    );
    if (outcome.ok) onDone(`Alat ${device.trim()} terpasang di ${chosen.plateDisplay}.`);
    else setFailure(trackerError(outcome.error));
  }

  const title = vehicle ? `Alat pelacak ${vehicle.plateDisplay}` : "Pasang alat pelacak";
  const loading = vehicle !== undefined && vehicle !== null && !current.data && !current.hasError;

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={title}
      description={attached ? undefined : "Posisi dari alat ini akan tampil di peta Lacak kendaraan untuk kendaraan yang dipilih."}
      submitLabel={attached ? "Lepas alat" : "Pasang"}
      pending={save.pending || loading}
      error={failure ?? (current.hasError ? errorMessage(current.error) : null)}
      onSubmit={handleSubmit}
    >
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Memeriksa alat yang terpasang
        </p>
      ) : attached ? (
        <div className="rounded-xl border bg-surface p-4 text-sm" data-testid="tracker-attached">
          <p className="font-medium">Kendaraan ini sudah memakai alat pelacak.</p>
          <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <dt className="text-muted-foreground">Sumber</dt>
            <dd>{attached.source.name}</dd>
            <dt className="text-muted-foreground">Nomor alat</dt>
            <dd className="ident">{attached.deviceId}</dd>
            <dt className="text-muted-foreground">Dipasang</dt>
            <dd>{formatDateTime(attached.attachedAt)}</dd>
          </dl>
          <p className="mt-3 text-muted-foreground">Lepas alat ini bila alatnya pindah truk atau rusak. Posisi yang sudah tersimpan tetap ada.</p>
        </div>
      ) : (
        <>
          {vehicle ? (
            <p className="text-sm">
              Kendaraan <span className="plate text-[0.8125rem]">{vehicle.plateDisplay}</span>
            </p>
          ) : (
            <EntityLookup<Vehicle>
              label="Kendaraan"
              placeholder="Cari nomor plat"
              name="trackerVehicle"
              scope="tracker-vehicle"
              search={(text, signal) => api.request<Page<Vehicle>>("/api/vehicles", { query: { q: text, limit: 20 }, signal })}
              optionKey={(item) => item.id}
              optionLabel={(item) => item.plateDisplay}
              optionDetail={(item) => item.owner?.name ?? null}
              valueLabel={chosen?.plateDisplay ?? null}
              onSelect={(item) => {
                setChosen({ id: item.id, plateDisplay: item.plateDisplay });
                setErrors((current) => ({ ...current, vehicle: undefined }));
              }}
              narrowBy="nomor plat"
              error={errors.vehicle}
            />
          )}
          <SelectField
            label="Sumber posisi"
            name="trackerSource"
            value={source}
            onChange={(value) => {
              setSource(value);
              setErrors((current) => ({ ...current, source: undefined }));
            }}
            emptyLabel={sources.data ? (activeSources.length > 0 ? "Pilih sumber" : "Belum ada sumber aktif") : "Memuat sumber"}
            options={activeSources.map((item) => ({ value: String(item.id), label: item.name }))}
            error={errors.source ?? (sources.hasError ? errorMessage(sources.error) : undefined)}
            hint="Sumber dibuat di Pengaturan GPS, satu untuk tiap penyedia alat."
          />
          <TextField
            label="Nomor alat"
            name="trackerDevice"
            value={device}
            onChange={(value) => {
              setDevice(value);
              setErrors((current) => ({ ...current, device: undefined }));
            }}
            error={errors.device}
            hint="Nomor atau IMEI alat, sama persis dengan yang dikirim penyedia."
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}
    </FormSheet>
  );
}
