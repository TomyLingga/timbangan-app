// The dialogs that need the station PIN: settings and manual plate entry. The PIN is checked by the API
// (POST /api/weighbridge/manual-plate) through the main process; the window never sees the station key.
import { type FormEvent, type InputHTMLAttributes, type ReactNode, useEffect, useState } from "react";
import type { SettingsError, SettingsForm, SettingsInput, UnlockPurpose } from "../../shared/bridge";

export type Dialog = null | { kind: "pin"; purpose: UnlockPurpose } | { kind: "settings" } | { kind: "manualPlate" };

interface Props {
  dialog: Dialog;
  setDialog(dialog: Dialog): void;
  manualPlate: string | null;
}

function Frame({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function PinDialog({ purpose, setDialog }: { purpose: UnlockPurpose; setDialog(dialog: Dialog): void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next: Dialog = purpose === "settings" ? { kind: "settings" } : { kind: "manualPlate" };

  useEffect(() => {
    // first setup: no station key yet, so the API cannot check a PIN
    if (purpose === "settings") void window.desktop.settingsNeedPin().then((needed) => !needed && setDialog(next));
  }, [purpose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await window.desktop.unlock(pin, purpose);
    setBusy(false);
    if (result.ok) setDialog(next);
    else {
      setError(result.message);
      setPin("");
    }
  };

  return (
    <Frame title={purpose === "settings" ? "Pengaturan" : "Ketik plat"} onClose={() => setDialog(null)}>
      <form onSubmit={submit}>
        <label className="form-field">
          <span>PIN stasiun</span>
          <input autoFocus type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" onClick={() => setDialog(null)}>
            Batal
          </button>
          <button type="submit" className="primary" disabled={busy || pin.length < 4}>
            {busy ? "Memeriksa…" : "Buka"}
          </button>
        </div>
      </form>
    </Frame>
  );
}

function ManualPlateDialog({ setDialog, current }: { setDialog(dialog: Dialog): void; current: string | null }) {
  const [plate, setPlate] = useState(current ?? "");
  const apply = async (value: string | null) => {
    await window.desktop.setManualPlate(value);
    setDialog(null);
  };
  return (
    <Frame title="Ketik plat" onClose={() => setDialog(null)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void apply(plate.trim() || null);
        }}
      >
        <label className="form-field">
          <span>Plat yang terlihat di truk</span>
          <input autoFocus className="plate-input" maxLength={20} value={plate} onChange={(event) => setPlate(event.target.value.toUpperCase())} />
        </label>
        <p className="form-hint">Plat ini dikirim menggantikan bacaan kamera sampai truk selesai ditimbang.</p>
        <div className="form-actions">
          <button type="button" onClick={() => void apply(null)}>
            Pakai kamera lagi
          </button>
          <button type="submit" className="primary" disabled={!plate.trim()}>
            Pakai plat ini
          </button>
        </div>
      </form>
    </Frame>
  );
}

function SettingsDialog({ setDialog }: { setDialog(dialog: Dialog): void }) {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [stationKey, setStationKey] = useState("");
  const [errors, setErrors] = useState<SettingsError[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.desktop.getSettings().then((loaded) => {
      if (loaded) setForm(loaded);
      else setDialog({ kind: "pin", purpose: "settings" });
    });
  }, [setDialog]);

  if (!form) return null;
  const errorOf = (field: string) => errors.find((error) => error.field === field)?.message;
  const set = (patch: Partial<SettingsForm>) => setForm({ ...form, ...patch });
  const setScale = (patch: Partial<SettingsForm["scale"]>) => setForm({ ...form, scale: { ...form.scale, ...patch } });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const input: SettingsInput = { apiBaseUrl: form.apiBaseUrl, plateReaderUrl: form.plateReaderUrl, cctvUrls: form.cctvUrls, scale: form.scale, stationKey };
    const result = await window.desktop.saveSettings(input);
    if (result.ok) setDialog(null);
    else {
      setErrors(result.errors);
      setMessage(result.message);
    }
  };

  const field = (label: string, name: string, value: string, onChange: (value: string) => void, extra: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="form-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={errorOf(name) ? true : undefined} {...extra} />
      {errorOf(name) && <em className="field-error">{errorOf(name)}</em>}
    </label>
  );

  return (
    <Frame title="Pengaturan" onClose={() => setDialog(null)}>
      <form onSubmit={save} className="settings">
        <fieldset>
          <legend>Server</legend>
          {field("Alamat server", "apiBaseUrl", form.apiBaseUrl, (value) => set({ apiBaseUrl: value }), { placeholder: "https://…" })}
          {field("Kunci stasiun", "stationKey", stationKey, setStationKey, {
            type: "password",
            autoComplete: "off",
            placeholder: form.hasStationKey ? "Tersimpan. Isi hanya untuk mengganti." : "Tempel kunci dari halaman Stasiun",
          })}
          {form.hasStationKey && !form.keyProtected && <p className="form-hint">Kunci tersimpan tanpa enkripsi karena Windows tidak menyediakannya.</p>}
        </fieldset>
        <fieldset>
          <legend>Kamera</legend>
          {field("Alamat pembaca plat", "plateReaderUrl", form.plateReaderUrl, (value) => set({ plateReaderUrl: value }), { placeholder: "http://…" })}
          {field("Gambar CCTV 1", "cctvUrls", form.cctvUrls[0] ?? "", (value) => set({ cctvUrls: [value, form.cctvUrls[1] ?? ""] }), { placeholder: "Alamat gambar JPEG, boleh kosong" })}
          {field("Gambar CCTV 2", "cctvUrls.2", form.cctvUrls[1] ?? "", (value) => set({ cctvUrls: [form.cctvUrls[0] ?? "", value] }), { placeholder: "Boleh kosong" })}
        </fieldset>
        <fieldset>
          <legend>Timbangan</legend>
          <label className="form-field">
            <span>Sambungan</span>
            <select value={form.scale.driver} onChange={(event) => setScale({ driver: event.target.value as SettingsForm["scale"]["driver"] })}>
              <option value="tcp">Jaringan (TCP)</option>
              <option value="serial">Serial (RS-232)</option>
              <option value="simulator">Simulator (uji)</option>
            </select>
          </label>
          {form.scale.driver === "tcp" && (
            <div className="form-row">
              {field("Alamat indikator", "scale.host", form.scale.host, (value) => setScale({ host: value }))}
              {field("Port", "scale.port", String(form.scale.port), (value) => setScale({ port: Number(value.replace(/\D/g, "")) || 0 }), { inputMode: "numeric" })}
            </div>
          )}
          {form.scale.driver === "serial" && (
            <div className="form-row">
              {field("Port serial", "scale.serialPath", form.scale.serialPath, (value) => setScale({ serialPath: value }), { placeholder: "COM1" })}
              {field("Baud rate", "scale.baudRate", String(form.scale.baudRate), (value) => setScale({ baudRate: Number(value.replace(/\D/g, "")) || 0 }), { inputMode: "numeric" })}
              <label className="form-field">
                <span>Data bit</span>
                <select value={form.scale.dataBits} onChange={(event) => setScale({ dataBits: event.target.value === "8" ? 8 : 7 })}>
                  <option value="7">7</option>
                  <option value="8">8</option>
                </select>
              </label>
              <label className="form-field">
                <span>Parity</span>
                <select value={form.scale.parity} onChange={(event) => setScale({ parity: event.target.value as SettingsForm["scale"]["parity"] })}>
                  <option value="none">none</option>
                  <option value="even">even</option>
                  <option value="odd">odd</option>
                </select>
              </label>
              <label className="form-field">
                <span>Stop bit</span>
                <select value={form.scale.stopBits} onChange={(event) => setScale({ stopBits: event.target.value === "2" ? 2 : 1 })}>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </label>
            </div>
          )}
        </fieldset>
        {message && <p className="form-error">{message}</p>}
        <div className="form-actions">
          <button type="button" onClick={() => setDialog(null)}>
            Batal
          </button>
          <button type="submit" className="primary">
            Simpan
          </button>
        </div>
      </form>
    </Frame>
  );
}

export function Dialogs({ dialog, setDialog, manualPlate }: Props) {
  if (!dialog) return null;
  if (dialog.kind === "pin") return <PinDialog key={dialog.purpose} purpose={dialog.purpose} setDialog={setDialog} />;
  if (dialog.kind === "settings") return <SettingsDialog setDialog={setDialog} />;
  return <ManualPlateDialog setDialog={setDialog} current={manualPlate} />;
}
