// The one screen of the weighbridge, in three columns: weight, prompt and truck on the left; the two CCTV
// pictures in the middle; difference, plate check, the four plate cameras and the steps on the right. The window
// only displays: every figure comes from the main process.
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScreenView, StationLinks } from "../../shared/bridge";
import { cameraLabel, type CameraReading } from "../../shared/cameras";
import { computeDifference, type DifferenceRow } from "../../shared/difference";
import { flowSteps, type PlateCheckStatus, plateVerification } from "../../shared/flow-steps";
import { displayPlate } from "../../shared/plate";
import type { ScreenState } from "../../shared/screen";
import { createSpeaker } from "./audio";
import { describePhase } from "./describe-phase";
import { type Dialog, Dialogs } from "./Dialogs";
import { Icon } from "./icons";

const groupKg = (value: number) => (value < 0 ? "-" : "") + String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const signedKg = (value: number) => (value > 0 ? "+" : "") + groupKg(value);
const percent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2).replace(".", ",")}%`;
const LIVE_PHASES = new Set(["truck", "settling", "countdown", "sending", "plateRetry", "waiting"]);
const FRAME_FRESH_MS = 3_000;

function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function Panel({ title, aside, className = "", children }: { title: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`panel ${className}`} aria-label={title}>
      <header className="panel-head">
        <h2 className="overline">{title}</h2>
        {aside !== undefined && <div className="panel-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

/* top bar ------------------------------------------------------------------ */

function TopBar(props: { view: ScreenView; onTheme(): void; onException(): void; onReset(): void; onSettings(): void }) {
  const { view } = props;
  const now = useNow(1_000);
  const { links, screen, display } = view;
  const machine = machineState(links, screen);
  const plates = links.platesOnline;
  const plateTone = plates === null ? "off" : plates === 4 ? "ok" : plates === 0 ? "bad" : "warn";
  const api = links.api === "ok" ? "ok" : links.api === "down" ? "bad" : "warn";
  return (
    <header className="top">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-title">Timbangan</span>
        {display.stationName && <span className="brand-station">{display.stationName}</span>}
      </div>
      <div className="chips">
        <span className={`chip tone-${machine.tone}`}>
          <span className="dot" aria-hidden="true" />
          Mesin <b>{machine.text}</b>
        </span>
        <span className={`chip tone-${plateTone}`}>
          <span className="dot" aria-hidden="true" />
          Kamera plat <b>{plates === null ? "tidak diatur" : `${plates}/4 online`}</b>
        </span>
        <span className={`chip tone-${api}`}>
          <span className="dot" aria-hidden="true" />
          Server <b>{links.api === "ok" ? "menjawab" : links.api === "down" ? "tidak menjawab" : "dicek"}</b>
        </span>
        <span className="chip chip-time">
          <Icon name="clock" />
          {now.toLocaleDateString("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
          <b className="tabular">{now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</b>
        </span>
      </div>
      <div className="actions">
        <button type="button" className="icon-button" onClick={props.onTheme} aria-label={display.theme === "dark" ? "Tema terang" : "Tema gelap"} title={display.theme === "dark" ? "Tema terang" : "Tema gelap"}>
          <Icon name={display.theme === "dark" ? "sun" : "moon"} />
        </button>
        <button type="button" className={`switch ${view.exceptionMode ? "on" : ""}`} role="switch" aria-checked={view.exceptionMode} onClick={props.onException} title="Exception: ketik plat dengan PIN (F3)">
          Exception
          <span className="switch-track" aria-hidden="true">
            <span className="switch-knob" />
          </span>
        </button>
        <button type="button" className="icon-button" onClick={props.onReset} aria-label="Batalkan timbang, kembali ke awal" title="Batalkan timbang, kembali ke awal">
          <Icon name="reset" />
        </button>
        <button type="button" className="icon-button" onClick={props.onSettings} aria-label="Pengaturan" title="Pengaturan (F2)">
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}

function machineState(links: StationLinks, screen: ScreenState): { text: string; tone: "ok" | "warn" | "bad" } {
  if (links.scale !== "connected") return { text: "terputus", tone: "bad" };
  if (screen.phase === "idle" && (screen.weightKg ?? 0) <= 0) return { text: "standby", tone: "warn" };
  return { text: "tersambung", tone: "ok" };
}

/* left column -------------------------------------------------------------- */

function Weight({ screen, links }: { screen: ScreenState; links: StationLinks }) {
  const reading = links.scale === "connected" ? screen.weightKg : null;
  const state = screen.phase === "countdown" || screen.phase === "sending" ? "locked" : screen.phase === "saved" || (screen.phase === "decided" && screen.outcome?.kind === "SAVED") ? "saved" : screen.phase === "waiting" ? "attention" : "";
  const card = screen.card;
  return (
    <section className={`panel weight ${state}`} aria-label="Berat">
      <header className="panel-head">
        <h2 className="overline">Berat</h2>
        {card && <span className="panel-aside">{`Timbang ${card.stage} · ${card.kind === "GROSS" ? "Bruto" : "Tarra"}`}</span>}
      </header>
      <div className="weight-value">
        <span className="weight-digits tabular">{reading === null ? "—" : groupKg(reading)}</span>
        <span className="weight-unit">kg</span>
      </div>
      {reading === null && <div className="weight-note">Timbangan tidak tersambung</div>}
    </section>
  );
}

function CountdownRing({ left }: { left: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const done = Math.min(1, Math.max(0, (3 - left + 1) / 3));
  return (
    <svg className="ring" viewBox="0 0 120 120" aria-hidden="true">
      <circle className="ring-track" cx="60" cy="60" r={radius} />
      <circle className="ring-fill" cx="60" cy="60" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - done)} />
      <text x="60" y="60" className="ring-number">
        {left}
      </text>
    </svg>
  );
}

const PHASE_ICON: Record<string, Parameters<typeof Icon>[0]["name"]> = { idle: "card", lookup: "card", truck: "truck", settling: "scale", sending: "send", saved: "check", plateRetry: "camera", waiting: "hourglass", decided: "flag", refused: "alert" };

function Prompt({ screen, spoken, speaking }: { screen: ScreenState; spoken: string[]; speaking: string | null }) {
  const text = describePhase(screen);
  const same = (a: string, b: string) => a.trim().replace(/\.$/, "").toLowerCase() === b.trim().replace(/\.$/, "").toLowerCase();
  const showMessage = screen.phase !== "idle" && screen.message.trim() !== "" && !same(screen.message, text.title);
  return (
    <section key={`${screen.phase}-${screen.exception?.id ?? ""}`} className={`panel prompt tone-${text.tone}`} aria-live="polite">
      <div className="prompt-mark">{screen.phase === "countdown" && screen.countdownLeft !== null ? <CountdownRing left={screen.countdownLeft} /> : <Icon name={PHASE_ICON[screen.phase] ?? "card"} />}</div>
      <div className="prompt-text">
        <div className="prompt-title">{text.title}</div>
        {text.detail && <div className="prompt-detail">{text.detail}</div>}
        {screen.notice && <div className="prompt-notice">{screen.notice}</div>}
        {showMessage && <div className="prompt-message">{screen.message}</div>}
        {spoken.length > 0 && (
          <div className="speech" aria-label="Suara">
            <Icon name={speaking ? "speaking" : "speaker"} />
            <span className="speech-lines">
              {spoken.map((part, index) => (
                <span key={index} className={part === speaking ? "speech-part now" : "speech-part"}>
                  {part}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className={`field-value ${mono ? "mono" : ""}`}>{value || "—"}</div>
    </div>
  );
}

function TruckData({ screen }: { screen: ScreenState }) {
  const card = screen.card;
  const trip = card?.trip;
  const aside = trip ? `${trip.tripNo ?? `Trip ${trip.id}`} · ${trip.direction === "IN" ? "Masuk" : "Keluar"}` : "Belum ada truk";
  return (
    <Panel title="Data truk" aside={aside} className="truck">
      <div className={`plate-hero ${card ? "" : "empty"}`}>{card ? displayPlate(card.expected.plateDisplay || card.expected.plateNo) : "— — —"}</div>
      <div className="fields">
        <Field label="RFID" value={screen.cardUid} mono />
        <Field label="Supir" value={trip?.driverName ?? null} />
        <Field label="Transporter" value={trip?.transporter?.name ?? null} />
        <Field label={trip?.direction === "OUT" ? "Pembeli" : "Pemasok"} value={trip?.partner.name ?? null} />
      </div>
    </Panel>
  );
}

/* middle column ------------------------------------------------------------ */

function Cctv({ title, configured, frame }: { title: string; configured: boolean; frame: { url: string | null; at: number } | undefined }) {
  const now = useNow(1_000).getTime();
  const live = Boolean(frame?.url) && now - (frame?.at ?? 0) < FRAME_FRESH_MS;
  return (
    <section className="panel cctv" aria-label={title}>
      {frame?.url && configured ? <img src={frame.url} alt={title} /> : null}
      {!(frame?.url && configured) && (
        <div className="cctv-empty">
          <Icon name="camera-off" />
          <span>{configured ? "Kamera tidak menjawab" : "Alamat CCTV belum diatur"}</span>
        </div>
      )}
      <div className="cctv-label">
        <Icon name="camera" />
        {title}
      </div>
      {live && <div className="cctv-live">LIVE</div>}
    </section>
  );
}

/* right column ------------------------------------------------------------- */

function DiffCell({ row, kind }: { row: DifferenceRow; kind: "doc" | "weighed" | "diff" }) {
  if (kind === "doc") return <td className="tabular">{row.doc === null ? "—" : groupKg(row.doc)}</td>;
  if (kind === "weighed") return <td className="tabular">{row.weighed === null ? "—" : groupKg(row.weighed)}</td>;
  if (row.diffKg === null) return <td className="tabular muted">—</td>;
  const tone = row.diffKg === 0 ? "" : "attention";
  return (
    <td className={`tabular diff ${tone}`}>
      <span>{signedKg(row.diffKg)}</span>
      {row.diffPct !== null && <small>{percent(row.diffPct)}</small>}
    </td>
  );
}

function DifferencePanel({ screen }: { screen: ScreenState }) {
  const card = screen.card;
  const trip = screen.outcome?.kind === "SAVED" && screen.outcome.trip ? screen.outcome.trip : card?.trip;
  const live = card && LIVE_PHASES.has(screen.phase) ? { kind: card.kind, weightKg: screen.attempt?.weightKg ?? screen.weightKg } : null;
  const result = computeDifference(
    { docGrossKg: card?.expected.docGrossKg ?? null, docTareKg: card?.expected.docTareKg ?? null, docNetKg: card?.expected.docNetKg ?? null },
    { grossKg: trip?.grossKg ?? null, tareKg: trip?.tareKg ?? null, netKg: trip?.netKg ?? null },
    live,
  );
  const rows = [result.gross, result.tare, result.net];
  return (
    <Panel title="Selisih" aside="kg" className="difference">
      <table className="diff-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Bruto</th>
            <th scope="col">Tarra</th>
            <th scope="col">Netto</th>
          </tr>
        </thead>
        <tbody>
          {(["doc", "weighed", "diff"] as const).map((kind) => (
            <tr key={kind}>
              <th scope="row">{kind === "doc" ? "Surat" : kind === "weighed" ? "Timbang" : "Selisih"}</th>
              {rows.map((row, index) => (
                <DiffCell key={index} row={row} kind={kind} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

const PLATE_STATUS: Record<PlateCheckStatus, { text: string; tone: string; icon: Parameters<typeof Icon>[0]["name"] }> = {
  WAITING_CARD: { text: "Menunggu kartu", tone: "idle", icon: "clock" },
  CHECKING: { text: "Memeriksa plat", tone: "active", icon: "camera" },
  SAME: { text: "Sama dengan plat terdaftar", tone: "ok", icon: "check" },
  DIFFERENT: { text: "Beda dengan plat terdaftar", tone: "warn", icon: "alert" },
  WAITING_DECISION: { text: "Menunggu keputusan atasan", tone: "warn", icon: "hourglass" },
};

function PlatePanel({ screen, exceptionMode, onManual }: { screen: ScreenState; exceptionMode: boolean; onManual(): void }) {
  const check = plateVerification(screen);
  const status = PLATE_STATUS[check.status];
  const attempt = check.maxAttempts !== null ? `Percobaan ${check.attempt}/${check.maxAttempts}` : `Percobaan ${check.attempt}`;
  return (
    <Panel title="Verifikasi plat" aside={attempt} className="plate-check">
      <div className="plate-read-row">
        <div>
          <div className="field-label">{screen.manualPlate ? "Plat diketik" : "Plat terbaca kamera"}</div>
          <div className="plate-read mono">{check.plate ? displayPlate(check.plate) : "—"}</div>
        </div>
        {exceptionMode && (
          <button type="button" className="small-button" onClick={onManual}>
            Ketik plat
          </button>
        )}
      </div>
      <div className={`status-pill tone-${status.tone}`}>
        <Icon name={status.icon} />
        {status.text}
      </div>
    </Panel>
  );
}

function CameraPanel({ cameras, used }: { cameras: CameraReading[]; used: number | null }) {
  return (
    <Panel title="Pembacaan kamera" className="cameras">
      <div className="camera-grid">
        {cameras.map((reading) => {
          const online = reading.status === "online" || reading.status === "lagging";
          return (
            <div key={reading.camera} className={`camera-cell ${reading.camera === used ? "used" : ""}`}>
              <div className="camera-head">
                <span className={`dot ${online ? "on" : ""}`} aria-hidden="true" />
                <span className="overline small">{cameraLabel(reading.camera)}</span>
              </div>
              <div className={`camera-plate ${reading.plate ? "mono" : "muted"}`}>{reading.plate ? displayPlate(reading.plate) : online ? "Tidak terbaca" : "Kamera mati"}</div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function StepsPanel({ screen }: { screen: ScreenState }) {
  return (
    <Panel title="Alur penimbangan" className="steps">
      <ol className="step-list">
        {flowSteps(screen).map((step, index) => (
          <li key={step.label} className={`step ${step.status}`}>
            <span className="step-mark" aria-hidden="true">
              {step.status === "done" ? <Icon name="check" /> : step.status === "failed" ? <Icon name="cross" /> : index + 1}
            </span>
            <span className="step-label">{step.label}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/* footer ------------------------------------------------------------------- */

function Notice({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const measure = () => setOverflow(Boolean(box.current && line.current && line.current.scrollWidth > box.current.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [text]);
  return (
    <footer className="notice">
      <div className="notice-label">
        <Icon name="megaphone" />
        Perhatian
      </div>
      <div className={`notice-text ${overflow ? "scrolling" : ""}`} ref={box}>
        <span ref={line}>{text}</span>
        {overflow && <span aria-hidden="true">{text}</span>}
      </div>
    </footer>
  );
}

/* screen ------------------------------------------------------------------- */

export function App() {
  const [view, setView] = useState<ScreenView | null>(null);
  const [spoken, setSpoken] = useState<string[]>([]);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [frames, setFrames] = useState<({ url: string | null; at: number } | undefined)[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const speaker = useMemo(() => createSpeaker(setSpeaking), []);
  const frameUrls = useRef<(string | null)[]>([]);
  const exceptionMode = view?.exceptionMode ?? false;

  useEffect(() => {
    void window.desktop.ready().then((first) => first && setView(first));
    const offView = window.desktop.onView(setView);
    const offSpeak = window.desktop.onSpeak((segments) => {
      setSpoken(segments);
      speaker.say(segments);
    });
    const offCctv = window.desktop.onCctv(({ index, jpeg }) => {
      const previous = frameUrls.current[index];
      if (previous) URL.revokeObjectURL(previous);
      const url = jpeg ? URL.createObjectURL(new Blob([jpeg.slice().buffer], { type: "image/jpeg" })) : null;
      frameUrls.current[index] = url;
      setFrames((current) => {
        const next = [...current];
        next[index] = { url, at: url ? Date.now() : (current[index]?.at ?? 0) };
        return next;
      });
    });
    return () => {
      offView();
      offSpeak();
      offCctv();
    };
  }, [speaker]);

  const openException = () => (exceptionMode ? void window.desktop.endException() : setDialog({ kind: "pin", purpose: "manualPlate" }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F2") setDialog({ kind: "pin", purpose: "settings" });
      if (event.key === "F3") setDialog(exceptionMode ? { kind: "manualPlate" } : { kind: "pin", purpose: "manualPlate" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exceptionMode]);

  useEffect(() => window.desktop.setTyping(dialog !== null), [dialog]);

  const theme = view?.display.theme ?? "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (!view) return <main className="screen loading">Menyiapkan…</main>;
  const { screen, links, display } = view;

  return (
    <main className={`screen phase-${screen.phase}`}>
      <TopBar view={view} onTheme={() => void window.desktop.toggleTheme()} onException={openException} onReset={() => setDialog({ kind: "reset" })} onSettings={() => setDialog({ kind: "pin", purpose: "settings" })} />
      <div className="columns">
        <div className="column left">
          <Weight screen={screen} links={links} />
          <Prompt screen={screen} spoken={spoken} speaking={speaking} />
          <TruckData screen={screen} />
        </div>
        <div className="column middle">
          <Cctv title="CCTV masuk" configured={display.cctvConfigured[0]} frame={frames[0]} />
          <Cctv title="CCTV keluar" configured={display.cctvConfigured[1]} frame={frames[1]} />
        </div>
        <div className="column right">
          <DifferencePanel screen={screen} />
          <PlatePanel screen={screen} exceptionMode={exceptionMode} onManual={() => setDialog({ kind: "manualPlate" })} />
          <CameraPanel cameras={view.cameras} used={screen.card?.camera ?? null} />
          <StepsPanel screen={screen} />
        </div>
      </div>
      <Notice text={display.notice} />
      <Dialogs dialog={dialog} setDialog={setDialog} manualPlate={screen.manualPlate} />
    </main>
  );
}
