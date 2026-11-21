"use client";

import { useRef, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Pencil, Plus, TriangleAlert } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { DataList, type Column } from "@/components/data-list";
import { CheckboxField, SelectField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, Notice, PageHeader, ResultCount } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { isApiError } from "@/lib/api-client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { stationErrorMessage } from "@/lib/messages";
import { canManageStations } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { Direction, Station, StationKind, WeighbridgeConfig } from "@/lib/types";
import { STATION_KIND_LABELS, stationKindLabel } from "@/lib/weighing";

const DIRECTION_WORDS: Record<Direction, string> = { IN: "incoming", OUT: "outgoing" };

function readConfig(station: Station): WeighbridgeConfig {
  const config = station.config as Partial<WeighbridgeConfig>;
  return {
    directions: Array.isArray(config.directions) ? config.directions : [],
    cameraWeigh1: typeof config.cameraWeigh1 === "number" ? config.cameraWeigh1 : null,
    cameraWeigh2: typeof config.cameraWeigh2 === "number" ? config.cameraWeigh2 : null,
    plateAttempts: typeof config.plateAttempts === "number" ? config.plateAttempts : 3,
  };
}

const COLUMNS: ReadonlyArray<Column<Station>> = [
  {
    id: "code",
    header: "Stasiun",
    primary: true,
    cell: (station) => (
      <span className="flex flex-col">
        <span className="ident font-semibold">{station.code}</span>
        <span className="text-sm text-muted-foreground">{station.name}</span>
      </span>
    ),
  },
  { id: "kind", header: "Jenis", cell: (station) => stationKindLabel(station.kind) },
  {
    id: "config",
    header: "Pengaturan",
    wide: true,
    cellClassName: "whitespace-normal",
    cell: (station) => {
      if (station.kind !== "WEIGHBRIDGE") return <span className="text-muted-foreground">-</span>;
      const config = readConfig(station);
      return (
        <span className="flex flex-col text-sm">
          <span>Arah {config.directions.map((item) => DIRECTION_WORDS[item] ?? item).join(" dan ") || "-"}</span>
          <span className="text-xs text-muted-foreground">
            Kamera {config.cameraWeigh1 ?? "-"} dan {config.cameraWeigh2 ?? "-"}, plat dicoba {formatNumber(config.plateAttempts)} kali
          </span>
        </span>
      );
    },
  },
  {
    id: "key",
    header: "Kunci mesin",
    cell: (station) =>
      station.hasKey ? (
        <span className="flex flex-col">
          <span>Ada</span>
          <span className="text-xs text-muted-foreground">{formatDateTime(station.keyCreatedAt)}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">Belum ada</span>
      ),
  },
  {
    id: "status",
    header: "Status",
    cell: (station) => <StatusBadge info={station.isActive ? { label: "Aktif", tone: "success" } : { label: "Nonaktif", tone: "neutral" }} />,
  },
];

type FormState = {
  code: string;
  name: string;
  kind: string;
  zoneId: string;
  isActive: boolean;
  directions: Direction[];
  cameraWeigh1: string;
  cameraWeigh2: string;
  plateAttempts: string;
  pin: string;
  removePin: boolean;
};

const EMPTY: FormState = { code: "", name: "", kind: "WEIGHBRIDGE", zoneId: "", isActive: true, directions: ["IN", "OUT"], cameraWeigh1: "", cameraWeigh2: "", plateAttempts: "3", pin: "", removePin: false };

function formOf(station: Station): FormState {
  const config = readConfig(station);
  return {
    code: station.code,
    name: station.name,
    kind: station.kind,
    zoneId: station.zoneId === null ? "" : String(station.zoneId),
    isActive: station.isActive,
    directions: config.directions,
    cameraWeigh1: config.cameraWeigh1 === null ? "" : String(config.cameraWeigh1),
    cameraWeigh2: config.cameraWeigh2 === null ? "" : String(config.cameraWeigh2),
    plateAttempts: String(config.plateAttempts),
    pin: "",
    removePin: false,
  };
}

const wholeNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

/** Checks the form like the API does and builds the body. */
function buildBody(form: FormState, editing: Station | null): { body: Record<string, unknown> | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!form.code.trim()) errors.code = "Isi kode.";
  else if (form.code.trim().length > 30) errors.code = "Kode paling banyak 30 huruf.";
  if (!form.name.trim()) errors.name = "Isi nama.";
  if (!form.kind) errors.kind = "Pilih jenis.";
  const zone = form.zoneId.trim() ? wholeNumber(form.zoneId) : null;
  if (zone !== null && !(zone > 0)) errors.zoneId = "Nomor zona berupa angka bulat.";
  if (form.pin.trim() && !/^\d{4,8}$/.test(form.pin.trim())) errors.pin = "PIN 4 sampai 8 angka.";

  let config: Record<string, unknown> | undefined;
  if (form.kind === "WEIGHBRIDGE") {
    if (form.directions.length === 0) errors.directions = "Pilih minimal satu arah.";
    const camera = (text: string, field: string) => {
      if (!text.trim()) return null;
      const value = wholeNumber(text);
      if (!(value >= 1 && value <= 99)) errors[field] = "Nomor kamera 1 sampai 99.";
      return value;
    };
    const attempts = wholeNumber(form.plateAttempts);
    if (!(attempts >= 1 && attempts <= 10)) errors.plateAttempts = "Isi 1 sampai 10.";
    config = { directions: form.directions, cameraWeigh1: camera(form.cameraWeigh1, "cameraWeigh1"), cameraWeigh2: camera(form.cameraWeigh2, "cameraWeigh2"), plateAttempts: attempts };
  } else if (!editing) config = {};

  if (Object.keys(errors).length > 0) return { body: null, errors };
  const body: Record<string, unknown> = { code: form.code.trim().toUpperCase(), name: form.name.trim(), kind: form.kind, zoneId: zone, isActive: form.isActive };
  if (config !== undefined) body.config = config;
  if (form.pin.trim()) body.pin = form.pin.trim();
  else if (editing && form.removePin) body.pin = null;
  return { body, errors };
}

/** Field messages of a 400 answer, by the names of this form. */
function serverFieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.code !== "VALIDATION") return {};
  const mapped: Record<string, string> = {};
  for (const [field, message] of Object.entries(error.fieldMessages)) mapped[field.replace(/^config\./, "")] = message;
  return mapped;
}

function StationSheet({ editing, onClose, onSaved }: { editing: Station | null; onClose: () => void; onSaved: (station: Station, created: boolean) => void }) {
  const [form, setForm] = useState<FormState>(editing ? formOf(editing) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit() {
    const { body, errors: found } = buildBody(form, editing);
    setErrors(found);
    setFailure(null);
    if (!body) return;
    setPending(true);
    try {
      const { station } = editing
        ? await api.request<{ station: Station }>(`/api/stations/${encodeURIComponent(String(editing.id))}`, { method: "PATCH", body })
        : await api.request<{ station: Station }>("/api/stations", { method: "POST", body });
      onSaved(station, !editing);
    } catch (error) {
      const fields = serverFieldErrors(error);
      if (Object.keys(fields).length) setErrors(fields);
      setFailure(Object.keys(fields).length ? "Periksa kolom yang ditandai." : stationErrorMessage(error));
      setPending(false);
    }
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={editing ? `Ubah stasiun ${editing.code}` : "Stasiun baru"}
      description="Timbangan memakai arah, nomor kamera pembaca plat, dan jumlah percobaan plat dari sini."
      pending={pending}
      error={failure}
      onSubmit={() => void submit()}
    >
      <TextField label="Kode" name="code" value={form.code} onChange={(value) => set("code", value)} error={errors.code} autoCapitalize="characters" className="[&_input]:font-mono [&_input]:uppercase" />
      <TextField label="Nama" name="name" value={form.name} onChange={(value) => set("name", value)} error={errors.name} />
      <SelectField
        label="Jenis"
        name="kind"
        value={form.kind}
        onChange={(value) => set("kind", value)}
        error={errors.kind}
        emptyLabel="Pilih jenis"
        options={Object.entries(STATION_KIND_LABELS).map(([value, label]) => ({ value, label }))}
      />
      <TextField
        label="Nomor zona"
        name="zoneId"
        inputMode="numeric"
        value={form.zoneId}
        onChange={(value) => set("zoneId", value)}
        error={errors.zoneId}
        hint="Nomor zona dari database. Kosongkan bila stasiun belum diberi zona."
        optional
      />
      {form.kind === ("WEIGHBRIDGE" satisfies StationKind) ? (
        <fieldset className="flex flex-col gap-3 rounded-2xl border p-4" aria-invalid={errors.directions ? true : undefined}>
          <legend className="px-1 text-sm font-semibold">Timbangan</legend>
          <div>
            <p className="text-sm font-medium">Arah yang dilayani</p>
            {(["IN", "OUT"] as const).map((direction) => (
              <CheckboxField
                key={direction}
                name={`direction-${direction}`}
                label={direction === "IN" ? "Incoming" : "Outgoing"}
                checked={form.directions.includes(direction)}
                onChange={(checked) => set("directions", checked ? [...form.directions, direction] : form.directions.filter((item) => item !== direction))}
              />
            ))}
            {errors.directions ? <p className="text-sm text-destructive">{errors.directions}</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Kamera timbang 1" name="cameraWeigh1" inputMode="numeric" value={form.cameraWeigh1} onChange={(value) => set("cameraWeigh1", value)} error={errors.cameraWeigh1} optional />
            <TextField label="Kamera timbang 2" name="cameraWeigh2" inputMode="numeric" value={form.cameraWeigh2} onChange={(value) => set("cameraWeigh2", value)} error={errors.cameraWeigh2} optional />
          </div>
          <TextField
            label="Percobaan plat"
            name="plateAttempts"
            inputMode="numeric"
            value={form.plateAttempts}
            onChange={(value) => set("plateAttempts", value)}
            error={errors.plateAttempts}
            hint="Berapa kali plat yang salah diminta ulang sebelum diteruskan ke Keputusan. 1 sampai 10."
          />
        </fieldset>
      ) : null}
      <TextField
        label={editing?.hasPin ? "PIN baru" : "PIN stasiun"}
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        value={form.pin}
        onChange={(value) => set("pin", value)}
        error={errors.pin}
        hint="4 sampai 8 angka. Dipakai di aplikasi timbang untuk membuka ketik plat dan pengaturan."
        optional
      />
      {editing?.hasPin ? <CheckboxField name="removePin" label="Hapus PIN" checked={form.removePin} onChange={(value) => set("removePin", value)} disabled={Boolean(form.pin.trim())} /> : null}
      <CheckboxField name="isActive" label="Aktif" description="Stasiun nonaktif tidak menerima kiriman dari aplikasi timbang." checked={form.isActive} onChange={(value) => set("isActive", value)} />
    </FormSheet>
  );
}

/** Makes a new machine key and shows it once. The old key stops working at once. */
function KeyDialog({ station, onClose, onMade }: { station: Station; onClose: () => void; onMade: (station: Station) => void }) {
  const [phase, setPhase] = useState<"confirm" | "making" | "shown">("confirm");
  const [key, setKey] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  async function make() {
    setPhase("making");
    setFailure(null);
    try {
      const answer = await api.request<{ station: Station; key: string }>(`/api/stations/${encodeURIComponent(String(station.id))}/key`, { method: "POST" });
      setKey(answer.key);
      setPhase("shown");
      onMade(answer.station);
    } catch (error) {
      setFailure(stationErrorMessage(error));
      setPhase("confirm");
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      // no clipboard on a page served over plain http: select the key so it can be copied by hand
      keyRef.current?.select();
    }
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => (open || phase === "making" ? undefined : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[oklch(0.15_0.015_255/0.4)] backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 dark:bg-[oklch(0.05_0.01_255/0.65)]" />
        <DialogPrimitive.Content
          className="fixed top-1/2 left-1/2 z-50 flex w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl border bg-popover p-5 text-popover-foreground shadow-overlay data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97]"
          data-testid="station-key-dialog"
        >
          <DialogPrimitive.Title className="text-lg font-semibold">Kunci mesin {station.code}</DialogPrimitive.Title>
          {phase === "shown" ? (
            <>
              <DialogPrimitive.Description className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-subtle p-3 text-sm text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                Kunci ini hanya ditampilkan sekali dan tidak bisa dilihat lagi. Simpan sekarang di pengaturan aplikasi timbang. Kunci lama sudah tidak berlaku.
              </DialogPrimitive.Description>
              <div className="flex gap-2">
                <input
                  ref={keyRef}
                  readOnly
                  value={key}
                  aria-label="Kunci mesin"
                  data-testid="station-key"
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                />
                <Button type="button" variant="outline" size="lg" onClick={() => void copy()}>
                  {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied ? "Tersalin" : "Salin"}
                </Button>
              </div>
              <div className="flex justify-end">
                <DialogPrimitive.Close asChild>
                  <Button>Sudah disimpan</Button>
                </DialogPrimitive.Close>
              </div>
            </>
          ) : (
            <>
              <DialogPrimitive.Description className="text-sm text-muted-foreground">
                {station.hasKey
                  ? "Kunci baru menggantikan kunci yang sekarang. Aplikasi timbang yang masih memakai kunci lama berhenti tersambung sampai kunci barunya dimasukkan."
                  : "Aplikasi timbang di stasiun ini memakai kunci ini untuk tersambung ke server."}{" "}
                Kunci ditampilkan sekali saja.
              </DialogPrimitive.Description>
              <div aria-live="polite">{failure ? <Notice tone="error">{failure}</Notice> : null}</div>
              <div className="flex justify-end gap-2">
                <DialogPrimitive.Close asChild>
                  <Button variant="outline" disabled={phase === "making"}>
                    Batal
                  </Button>
                </DialogPrimitive.Close>
                <Button onClick={() => void make()} disabled={phase === "making"}>
                  {phase === "making" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
                  Buat kunci mesin
                </Button>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function StationsPage() {
  const [token, setToken] = useState(0);
  const [sheet, setSheet] = useState<{ editing: Station | null } | null>(null);
  const [keyFor, setKeyFor] = useState<Station | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useApiQuery(`stations|${token}`, (signal) => api.request<{ items: Station[] }>("/api/stations", { signal }), { keepPrevious: true });
  const items = list.data?.items ?? [];
  const weighbridges = items.filter((item) => item.kind === "WEIGHBRIDGE");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Stasiun"
        figures={
          list.data ? (
            <>
              <span>
                <span className="font-semibold text-foreground tabular-nums">{formatNumber(weighbridges.length)}</span> timbangan
              </span>
              <span>
                <span className="font-semibold text-foreground tabular-nums">{formatNumber(weighbridges.filter((item) => !item.hasKey).length)}</span> belum punya kunci
              </span>
            </>
          ) : null
        }
        description="Titik kerja di pabrik. Aplikasi timbang tersambung dengan kunci mesin dari halaman ini."
      >
        <Button onClick={() => setSheet({ editing: null })}>
          <Plus aria-hidden="true" />
          Stasiun baru
        </Button>
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>

      {list.hasError && !list.data ? (
        <ListError title="Daftar stasiun belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar stasiun" />
      ) : items.length === 0 ? (
        <ListEmpty title="Belum ada stasiun" hint="Tambahkan timbangan dulu, lalu buat kunci mesinnya." />
      ) : (
        <div className="flex flex-col gap-3">
          <ResultCount shown={items.length} total={items.length} noun="stasiun" />
          <DataList
            columns={COLUMNS}
            rows={items}
            rowKey={(station) => station.id}
            stale={list.isStale}
            actions={(station) => (
              <span className="flex justify-end gap-1">
                <Button variant="ghost" size="sm" className="h-10 md:h-8" onClick={() => setSheet({ editing: station })} aria-label={`Ubah ${station.code}`}>
                  <Pencil aria-hidden="true" />
                  <span className="max-md:sr-only">Ubah</span>
                </Button>
                <Button variant="outline" size="sm" className="h-10 md:h-8" onClick={() => setKeyFor(station)} aria-label={`Buat kunci mesin ${station.code}`}>
                  <KeyRound aria-hidden="true" />
                  <span className="max-md:sr-only">Kunci</span>
                </Button>
              </span>
            )}
          />
        </div>
      )}

      {sheet ? (
        <StationSheet
          editing={sheet.editing}
          onClose={() => setSheet(null)}
          onSaved={(station, created) => {
            setSheet(null);
            setNotice(created ? `Stasiun ${station.code} ditambahkan.` : `Stasiun ${station.code} diperbarui.`);
            setToken((value) => value + 1);
          }}
        />
      ) : null}
      {keyFor ? (
        <KeyDialog
          station={keyFor}
          onClose={() => setKeyFor(null)}
          onMade={(station) => {
            setNotice(`Kunci mesin ${station.code} dibuat ${formatDateTime(station.keyCreatedAt)}.`);
            setToken((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}

export function StationsScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canManageStations(state.user)) {
    return <AccessDenied module="weighbridge" reason="Halaman Stasiun butuh hak akses Timbangan tingkat ubah. Minta admin sistem memberi Anda hak akses itu." />;
  }
  return <StationsPage />;
}
