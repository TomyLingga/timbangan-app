"use client";

import { useMemo, useState, type FormEvent } from "react";
import { KeyRound, MapPin, Plus, Power, RadioTower, Send, Unplug } from "lucide-react";

import { ActionSheet } from "@/components/action-sheet";
import { SelectField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import { AccessDenied, ListError, Notice, PageHeader, Panel } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-provider";
import { KeyDialog } from "@/features/tracking/key-dialog";
import { TrackingTabs } from "@/features/tracking/parts";
import { PlantPicker } from "@/features/tracking/plant-picker";
import { TrackerSheet } from "@/features/tracking/tracker-sheet";
import { useApiQuery } from "@/hooks/use-api-query";
import { useAction } from "@/hooks/use-form";
import { isApiError } from "@/lib/api-client";
import { API_URL } from "@/lib/config";
import { formatDateTime, formatNumber } from "@/lib/format";
import {
  agoText,
  trackerExample,
  validateGpsSettings,
  type GpsSettings,
  type GpsSettingsValues,
  type GpsSource,
  type GpsSourceKind,
  type GpsTracker,
  type UnknownDevice,
} from "@/lib/gps";
import { errorMessage } from "@/lib/messages";
import { canManageGps } from "@/lib/permissions";
import { api } from "@/lib/session";

const KIND_LABELS: Record<GpsSourceKind, string> = { PROVIDER: "Penyedia, banyak alat", DEVICE: "Satu alat" };

const idOf = (value: string | number) => encodeURIComponent(String(value));

function NewSourceSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (source: GpsSource, key: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("PROVIDER");
  const [errors, setErrors] = useState<{ name?: string; kind?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const save = useAction();

  async function handleSubmit() {
    const found = { name: name.trim() ? undefined : "Isi nama sumber, misalnya nama penyedia alat.", kind: kind ? undefined : "Pilih jenis sumber." };
    setErrors(found);
    setFailure(null);
    if (found.name || found.kind) return;
    const outcome = await save.run(() => api.request<{ source: GpsSource; key: string }>("/api/gps/sources", { method: "POST", body: { name: name.trim(), kind } }));
    if (outcome.ok) onCreated(outcome.value.source, outcome.value.key);
    else setFailure(isApiError(outcome.error) && outcome.error.status === 400 ? "Periksa lagi nama dan jenis sumber." : errorMessage(outcome.error));
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Sumber posisi baru"
      description="Satu sumber untuk tiap penyedia alat pelacak, atau untuk satu alat yang mengirim sendiri. Kuncinya tampil sekali setelah disimpan."
      submitLabel="Buat dan tampilkan kunci"
      pending={save.pending}
      error={failure}
      onSubmit={handleSubmit}
    >
      <TextField label="Nama" name="sourceName" value={name} onChange={setName} error={errors.name} maxLength={100} autoComplete="off" />
      <SelectField
        label="Jenis"
        name="sourceKind"
        value={kind}
        onChange={setKind}
        emptyLabel="Pilih jenis"
        options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
        error={errors.kind}
      />
    </FormSheet>
  );
}

function UnknownDevices({ source, reloadToken, onAttach }: { source: GpsSource; reloadToken: number; onAttach: (deviceId: string) => void }) {
  const query = useApiQuery(`unknown|${source.id}|${reloadToken}`, (signal) =>
    api.request<{ items: UnknownDevice[] }>(`/api/gps/sources/${idOf(source.id)}/unknown-devices`, { signal }),
  );
  if (query.hasError) return <p className="text-sm text-destructive">{errorMessage(query.error)}</p>;
  if (!query.data) return <Skeleton className="h-10 w-full" />;
  if (query.data.items.length === 0) return <p className="text-sm text-muted-foreground">Semua nomor alat dari sumber ini sudah terpasang di kendaraan.</p>;
  return (
    <ul className="flex flex-col divide-y rounded-xl border" data-testid="unknown-devices">
      {query.data.items.map((device) => (
        <li key={device.deviceId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
          <span className="min-w-0">
            <span className="ident block text-sm font-medium">{device.deviceId}</span>
            <span className="block text-xs text-muted-foreground">
              {formatNumber(device.pointCount)} titik, terakhir {formatDateTime(device.lastSeenAt)}
            </span>
          </span>
          <Button variant="outline" size="sm" onClick={() => onAttach(device.deviceId)} aria-label={`Pasang ${device.deviceId} ke kendaraan`}>
            Pasang ke kendaraan
          </Button>
        </li>
      ))}
    </ul>
  );
}

function SourcesPanel({
  now,
  onKey,
  onAttachDevice,
  reloadToken,
  onChanged,
}: {
  now: number;
  onKey: (name: string, key: string) => void;
  onAttachDevice: (source: GpsSource, deviceId: string) => void;
  reloadToken: number;
  onChanged: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ source: GpsSource; action: "key" | "deactivate" } | null>(null);
  const [openUnknown, setOpenUnknown] = useState<string | null>(null);
  const query = useApiQuery(`sources|${reloadToken}`, (signal) => api.request<{ items: GpsSource[] }>("/api/gps/sources", { signal }), { keepPrevious: true });

  return (
    <Panel
      title="Sumber posisi"
      icon={RadioTower}
      data-testid="gps-sources"
      action={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          Sumber baru
        </Button>
      }
    >
      {query.hasError ? (
        <ListError title="Sumber belum bisa dimuat" error={query.error} onRetry={query.reload} />
      ) : !query.data ? (
        <Skeleton className="h-24 w-full" />
      ) : query.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada sumber. Buat satu untuk tiap penyedia alat pelacak; posisi dari ponsel supir tidak butuh sumber.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.items.map((source) => {
            const unknownOpen = openUnknown === String(source.id);
            return (
              <li key={String(source.id)} className="rounded-xl border p-3.5" data-testid="gps-source" data-source-name={source.name}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {source.name}
                      <StatusBadge info={source.isActive ? { label: "Aktif", tone: "success" } : { label: "Nonaktif", tone: "neutral" }} />
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {KIND_LABELS[source.kind] ?? source.kind} · {formatNumber(source.trackers)} alat terpasang ·{" "}
                      {source.lastSeenAt ? `terakhir mengirim ${agoText(source.lastSeenAt, now)}` : "belum pernah mengirim"}
                      {source.keyCreatedAt ? ` · kunci dibuat ${formatDateTime(source.keyCreatedAt)}` : ""}
                    </p>
                  </div>
                  {source.isActive ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => setConfirm({ source, action: "key" })} aria-label={`Buat kunci baru ${source.name}`}>
                        <KeyRound aria-hidden="true" />
                        Kunci baru
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirm({ source, action: "deactivate" })} aria-label={`Nonaktifkan ${source.name}`}>
                        <Power aria-hidden="true" />
                        Nonaktifkan
                      </Button>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-expanded={unknownOpen}
                  onClick={() => setOpenUnknown(unknownOpen ? null : String(source.id))}
                  className="mt-2 inline-flex min-h-9 items-center rounded-md text-sm text-link underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {unknownOpen ? "Tutup nomor alat yang belum dikenal" : "Nomor alat yang belum dikenal"}
                </button>
                {unknownOpen ? (
                  <div className="mt-2">
                    <UnknownDevices source={source} reloadToken={reloadToken} onAttach={(deviceId) => onAttachDevice(source, deviceId)} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <NewSourceSheet
          onClose={() => setCreating(false)}
          onCreated={(source, key) => {
            setCreating(false);
            onChanged(`Sumber ${source.name} dibuat.`);
            onKey(source.name, key);
          }}
        />
      ) : null}
      {confirm ? (
        <ActionSheet
          title={confirm.action === "key" ? `Kunci baru untuk ${confirm.source.name}` : `Nonaktifkan ${confirm.source.name}`}
          description={
            confirm.action === "key"
              ? "Kunci lama langsung tidak berlaku. Penyedia harus memakai kunci baru agar posisi tetap masuk."
              : "Semua kiriman dengan kunci sumber ini ditolak. Alat yang terpasang tidak mengirim posisi lagi."
          }
          submitLabel={confirm.action === "key" ? "Buat kunci baru" : "Nonaktifkan"}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const { source, action } = confirm;
            try {
              if (action === "key") {
                const answer = await api.request<{ source: GpsSource; key: string }>(`/api/gps/sources/${idOf(source.id)}/key`, { method: "POST" });
                setConfirm(null);
                onChanged(`Kunci baru untuk ${source.name} dibuat. Kunci lama tidak berlaku lagi.`);
                onKey(source.name, answer.key);
              } else {
                await api.request(`/api/gps/sources/${idOf(source.id)}/deactivate`, { method: "POST" });
                setConfirm(null);
                onChanged(`Sumber ${source.name} dinonaktifkan.`);
              }
              return null;
            } catch (error) {
              return isApiError(error) && error.code === "INVALID_STATE" ? "Sumber ini sudah tidak aktif." : errorMessage(error);
            }
          }}
        />
      ) : null}
    </Panel>
  );
}

function TrackersPanel({ reloadToken, onAttach, onChanged }: { reloadToken: number; onAttach: () => void; onChanged: (message: string) => void }) {
  const [detaching, setDetaching] = useState<GpsTracker | null>(null);
  const query = useApiQuery(`trackers|${reloadToken}`, (signal) => api.request<{ items: GpsTracker[] }>("/api/gps/trackers", { signal }), { keepPrevious: true });
  const active = (query.data?.items ?? []).filter((tracker) => tracker.isActive);

  return (
    <Panel
      title="Alat pelacak terpasang"
      icon={MapPin}
      data-testid="gps-trackers"
      action={
        <Button size="sm" variant="outline" onClick={onAttach}>
          <Plus aria-hidden="true" />
          Pasang alat
        </Button>
      }
    >
      {query.hasError ? (
        <ListError title="Alat pelacak belum bisa dimuat" error={query.error} onRetry={query.reload} />
      ) : !query.data ? (
        <Skeleton className="h-24 w-full" />
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada alat yang terpasang di kendaraan.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {active.map((tracker) => (
            <li key={String(tracker.id)} className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3" data-testid="gps-tracker" data-plate={tracker.vehicle.plateDisplay}>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="plate text-[0.8125rem]">{tracker.vehicle.plateDisplay}</span>
                  <span className="ident text-sm">{tracker.deviceId}</span>
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {tracker.source.name} · dipasang {formatDateTime(tracker.attachedAt)}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => setDetaching(tracker)} aria-label={`Lepas alat ${tracker.deviceId} dari ${tracker.vehicle.plateDisplay}`}>
                <Unplug aria-hidden="true" />
                Lepas
              </Button>
            </li>
          ))}
        </ul>
      )}
      {detaching ? (
        <ActionSheet
          title={`Lepas alat dari ${detaching.vehicle.plateDisplay}`}
          description={`Alat ${detaching.deviceId} tidak lagi mengirim posisi untuk kendaraan ini. Posisi yang sudah tersimpan tetap ada.`}
          submitLabel="Lepas alat"
          onClose={() => setDetaching(null)}
          onConfirm={async () => {
            try {
              await api.request(`/api/gps/trackers/${idOf(detaching.id)}/detach`, { method: "POST" });
              const done = detaching;
              setDetaching(null);
              onChanged(`Alat ${done.deviceId} dilepas dari ${done.vehicle.plateDisplay}.`);
              return null;
            } catch (error) {
              return isApiError(error) && error.code === "INVALID_STATE" ? "Alat ini sudah dilepas." : errorMessage(error);
            }
          }}
        />
      ) : null}
    </Panel>
  );
}

const textOf = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

function SettingsForm({ settings, onSaved }: { settings: GpsSettings; onSaved: (settings: GpsSettings) => void }) {
  const [values, setValues] = useState<GpsSettingsValues>({
    lat: textOf(settings.plantLocation?.lat),
    lon: textOf(settings.plantLocation?.lon),
    retentionDays: String(settings.retentionDays),
    customerDaysAfterExit: String(settings.customerDaysAfterExit),
  });
  const [errors, setErrors] = useState<Partial<Record<keyof GpsSettingsValues, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const set = (key: keyof GpsSettingsValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setSaved(false);
  };
  const checked = validateGpsSettings(values);
  const pin = checked.payload?.plantLocation ?? null;
  const pinLat = pin?.lat ?? null;
  const pinLon = pin?.lon ?? null;
  const location = useMemo(() => (pinLat !== null && pinLon !== null ? { lat: pinLat, lon: pinLon } : null), [pinLat, pinLon]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setErrors(checked.errors);
    if (!checked.payload) return;
    const body = checked.payload;
    const outcome = await save.run(() => api.request<{ settings: GpsSettings }>("/api/gps/settings", { method: "PUT", body }));
    if (outcome.ok) {
      setSaved(true);
      onSaved(outcome.value.settings);
    } else setFailure(isApiError(outcome.error) && outcome.error.status === 400 ? "Server menolak isian ini. Periksa lagi angkanya." : errorMessage(outcome.error));
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5" data-testid="gps-settings-form">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold">Lokasi pabrik</h3>
          <p className="-mt-2 text-sm text-muted-foreground">Dipakai untuk jarak truk ke pabrik di peta. Kosongkan keduanya bila belum mau dipakai.</p>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Lintang" name="plantLat" inputMode="decimal" value={values.lat} onChange={(value) => set("lat", value)} error={errors.lat} placeholder="-10,5" optional />
            <TextField label="Bujur" name="plantLon" inputMode="decimal" value={values.lon} onChange={(value) => set("lon", value)} error={errors.lon} placeholder="85,25" optional />
          </div>
          <PlantPicker
            location={location}
            onPick={(point) => {
              set("lat", String(point.lat));
              set("lon", String(point.lon));
            }}
          />
        </div>
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold">Penyimpanan dan batas lihat</h3>
          <TextField
            label="Simpan jejak (hari)"
            name="retentionDays"
            inputMode="numeric"
            value={values.retentionDays}
            onChange={(value) => set("retentionDays", value)}
            error={errors.retentionDays}
            hint="7 sampai 730 hari. Titik yang lebih tua dihapus sekali sehari; posisi terakhir tiap truk tetap ada."
          />
          <TextField
            label="Customer melihat truk setelah keluar pabrik (hari)"
            name="customerDaysAfterExit"
            inputMode="numeric"
            value={values.customerDaysAfterExit}
            onChange={(value) => set("customerDaysAfterExit", value)}
            error={errors.customerDaysAfterExit}
            hint="0 sampai 30 hari. Juga lama tautan Bagikan lokasi di SPJ outgoing tetap terbuka."
          />
        </div>
      </div>
      <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {failure ? <Notice tone="error">{failure}</Notice> : null}
        {saved ? <Notice tone="success">Pengaturan GPS disimpan.</Notice> : null}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={save.pending}>
          {save.pending ? "Menyimpan" : "Simpan pengaturan"}
        </Button>
      </div>
    </form>
  );
}

function HowToSend() {
  const example = trackerExample(API_URL);
  return (
    <Panel title="Cara mengirim posisi" icon={Send} data-testid="gps-howto">
      <div className="flex flex-col gap-3 text-sm">
        <p className="max-w-3xl text-muted-foreground">
          Untuk penyedia alat pelacak: kirim POST berisi JSON ke alamat ini, dengan kunci kiriman sumbernya di header. Paling banyak 500 titik per kiriman. Waktu
          memakai format ISO 8601 dengan zona waktu.
        </p>
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Alamat</dt>
          <dd className="ident break-all">{example.url}</dd>
          <dt className="text-muted-foreground">Header</dt>
          <dd className="ident break-all">{example.header}: &lt;kunci kiriman&gt;</dd>
        </dl>
        <pre className="ident overflow-x-auto rounded-xl border bg-surface p-3 text-xs leading-relaxed">{example.body}</pre>
      </div>
    </Panel>
  );
}

/** Pengaturan GPS: sources and their keys, trackers on vehicles, the plant's location and how long data is kept. */
export function GpsSettingsScreen() {
  const { state } = useAuth();
  const user = state.status === "authenticated" ? state.user : null;
  const mayManage = canManageGps(user);
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<{ name: string; key: string } | null>(null);
  const [attaching, setAttaching] = useState<{ sourceId?: string | number; deviceId?: string } | null>(null);
  const [now] = useState(() => Date.now());
  const settings = useApiQuery(mayManage ? "gps-settings" : null, (signal) => api.request<{ settings: GpsSettings }>("/api/gps/settings", { signal }));

  if (!user) return null;
  if (!mayManage) return <AccessDenied module="gps" reason="Pengaturan GPS hanya untuk petugas yang boleh mengubah modul Lacak kendaraan." />;

  const changed = (message: string) => {
    setNotice(message);
    setReloadToken((value) => value + 1);
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Pengaturan GPS" description="Sumber posisi dan kuncinya, alat pelacak di kendaraan, lokasi pabrik, dan lama data disimpan.">
        <TrackingTabs current="settings" />
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <SourcesPanel
          now={now}
          reloadToken={reloadToken}
          onChanged={changed}
          onKey={(name, key) => setShownKey({ name, key })}
          onAttachDevice={(source, deviceId) => setAttaching({ sourceId: source.id, deviceId })}
        />
        <TrackersPanel reloadToken={reloadToken} onAttach={() => setAttaching({})} onChanged={changed} />
      </div>

      <Panel title="Lokasi pabrik dan penyimpanan" icon={MapPin}>
        {settings.hasError ? (
          <ListError title="Pengaturan belum bisa dimuat" error={settings.error} onRetry={settings.reload} />
        ) : !settings.data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <SettingsForm settings={settings.data.settings} onSaved={() => setNotice(null)} />
        )}
      </Panel>

      <HowToSend />

      {shownKey ? <KeyDialog sourceName={shownKey.name} secret={shownKey.key} onClose={() => setShownKey(null)} /> : null}
      {attaching ? (
        <TrackerSheet
          sourceId={attaching.sourceId}
          deviceId={attaching.deviceId}
          onClose={() => setAttaching(null)}
          onDone={(message) => {
            setAttaching(null);
            changed(message);
          }}
        />
      ) : null}
    </div>
  );
}
