// The one screen of the weighbridge: the weight, the current step, the truck and its plates, what is being said,
// and the state of the scale, server and plate reader. Readable from two metres.
import { useEffect, useMemo, useRef, useState } from "react";
import type { StationLinks, StationView } from "../../shared/bridge";
import { comparePlates, displayPlate } from "../../shared/plate";
import type { ScreenState } from "../../shared/screen";
import { createSpeaker } from "./audio";
import { describePhase } from "./describe-phase";
import { type Dialog, Dialogs } from "./Dialogs";

const formatKg = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

function Light({ label, state, detail }: { label: string; state: "ok" | "warn" | "bad" | "off"; detail: string }) {
  return (
    <div className={`light light-${state}`} title={detail}>
      <span className="light-dot" aria-hidden="true" />
      <span className="light-label">{label}</span>
      <span className="light-detail">{detail}</span>
    </div>
  );
}

function Lights({ links }: { links: StationLinks }) {
  const scale = links.scale === "connected" ? (["ok", "tersambung"] as const) : links.scale === "connecting" ? (["warn", "menyambung"] as const) : links.scale === "unavailable" ? (["bad", "tidak tersedia"] as const) : (["bad", "terputus"] as const);
  const api = links.api === "ok" ? (["ok", "menjawab"] as const) : links.api === "down" ? (["bad", "tidak menjawab"] as const) : (["warn", "belum dicek"] as const);
  const plate =
    links.plate === "online" ? (["ok", "aktif"] as const) : links.plate === "off" ? (["off", "tidak diatur"] as const) : links.plate === "unknown" ? (["warn", "menunggu"] as const) : links.plate === "lagging" ? (["warn", "lambat"] as const) : (["bad", links.plate === "offline" ? "kamera mati" : "tidak menjawab"] as const);
  return (
    <div className="lights" role="status" aria-label="Sambungan">
      <Light label="Timbangan" state={scale[0]} detail={scale[1]} />
      <Light label="Server" state={api[0]} detail={api[1]} />
      <Light label="Pembaca plat" state={plate[0]} detail={plate[1]} />
    </div>
  );
}

function Weight({ screen, links }: { screen: ScreenState; links: StationLinks }) {
  const reading = links.scale === "connected" ? screen.weightKg : null;
  const tone = screen.phase === "countdown" || screen.phase === "sending" ? "locked" : screen.phase === "saved" ? "saved" : "";
  return (
    <section className={`weight ${tone}`} aria-label="Berat">
      <div className="weight-label">Berat</div>
      <div className="weight-value">
        <span className="weight-digits">{reading === null ? "—" : formatKg(reading)}</span>
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

function Phase({ screen }: { screen: ScreenState }) {
  const text = describePhase(screen);
  return (
    <section key={`${screen.phase}-${screen.exception?.id ?? ""}`} className={`phase tone-${text.tone}`} aria-live="polite">
      {screen.phase === "countdown" && screen.countdownLeft !== null ? <CountdownRing left={screen.countdownLeft} /> : <span className="phase-mark" aria-hidden="true" />}
      <div className="phase-text">
        <div className="phase-title">{text.title}</div>
        {text.detail && <div className="phase-detail">{text.detail}</div>}
        {screen.notice && <div className="phase-notice">{screen.notice}</div>}
      </div>
    </section>
  );
}

function Plates({ screen }: { screen: ScreenState }) {
  const registered = screen.card?.expected.plateDisplay ?? "";
  const read = screen.manualPlate ?? screen.cameraPlate;
  const match = comparePlates(read, screen.card?.expected.plateNo);
  const label = match === "MATCH" ? "Sama" : match === "DIFFERENT" ? "Beda" : "Belum terbaca";
  return (
    <div className="plates">
      <div className="plate-box">
        <div className="field-label">Plat terdaftar</div>
        <div className="plate">{displayPlate(registered) || "—"}</div>
      </div>
      <div className={`plate-box match-${match.toLowerCase()}`}>
        <div className="field-label">{screen.manualPlate ? "Plat diketik" : "Plat kamera"}</div>
        <div className="plate">{displayPlate(read) || "—"}</div>
        <div className="plate-match">{label}</div>
      </div>
    </div>
  );
}

function Truck({ screen }: { screen: ScreenState }) {
  const card = screen.card;
  if (!card) {
    return (
      <section className="truck empty" aria-label="Truk">
        <div className="truck-empty">Belum ada truk</div>
        <div className="truck-hint">Supir menempelkan kartu di pembaca</div>
      </section>
    );
  }
  const trip = card.trip;
  return (
    <section className="truck" aria-label="Truk">
      <div className="truck-head">
        <span className="chip">{trip.direction === "IN" ? "Masuk" : "Keluar"}</span>
        <span className="chip">Timbang {card.stage}</span>
        <span className="chip">{card.kind === "GROSS" ? "Bruto" : "Tarra"}</span>
        <span className="trip-no">{trip.tripNo ?? `Trip ${trip.id}`}</span>
      </div>
      <Plates screen={screen} />
      <dl className="truck-facts">
        <div>
          <dt>Supir</dt>
          <dd>{trip.driverName ?? "—"}</dd>
        </div>
        <div>
          <dt>{trip.direction === "IN" ? "Pemasok" : "Pembeli"}</dt>
          <dd>{trip.partner.name}</dd>
        </div>
      </dl>
    </section>
  );
}

function Cctv({ frames }: { frames: (string | null)[] }) {
  if (frames.length === 0) return null;
  return (
    <section className="cctv" aria-label="CCTV">
      {frames.map((url, index) => (
        <div className="cctv-frame" key={index}>
          {url ? <img src={url} alt={`CCTV ${index + 1}`} /> : <span>CCTV {index + 1} tidak tampil</span>}
        </div>
      ))}
    </section>
  );
}

function Message({ screen, spoken, speaking }: { screen: ScreenState; spoken: string[]; speaking: string | null }) {
  return (
    <section className="message" aria-live="polite">
      <div className="message-text">{screen.message}</div>
      <div className="speech" aria-label="Suara">
        <svg className="speech-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4z" />
          <path className={speaking ? "wave on" : "wave"} d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />
        </svg>
        <div className="speech-lines">
          {spoken.length === 0 ? (
            <span className="speech-part">—</span>
          ) : (
            spoken.map((part, index) => (
              <span key={index} className={part === speaking ? "speech-part now" : "speech-part"}>
                {part}
              </span>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

export function App() {
  const [view, setView] = useState<StationView | null>(null);
  const [spoken, setSpoken] = useState<string[]>([]);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [frames, setFrames] = useState<(string | null)[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const speaker = useMemo(() => createSpeaker(setSpeaking), []);
  const frameUrls = useRef<(string | null)[]>([]);
  const clock = useClock();

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
      setFrames([...frameUrls.current]);
    });
    return () => {
      offView();
      offSpeak();
      offCctv();
    };
  }, [speaker]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F2") setDialog({ kind: "pin", purpose: "settings" });
      if (event.key === "F3") setDialog({ kind: "pin", purpose: "manualPlate" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => window.desktop.setTyping(dialog !== null), [dialog]);

  if (!view) return <main className="screen loading">Menyiapkan…</main>;
  const { screen, links } = view;

  return (
    <main className={`screen phase-${screen.phase}`}>
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Timbangan</span>
        </div>
        <Lights links={links} />
        <div className="top-actions">
          <button type="button" onClick={() => setDialog({ kind: "pin", purpose: "manualPlate" })}>
            Ketik plat <kbd>F3</kbd>
          </button>
          <button type="button" onClick={() => setDialog({ kind: "pin", purpose: "settings" })}>
            Pengaturan <kbd>F2</kbd>
          </button>
          <time className="clock">{clock}</time>
        </div>
      </header>
      <div className="body">
        <div className="left">
          <Weight screen={screen} links={links} />
          <Phase screen={screen} />
        </div>
        <div className="right">
          <Truck screen={screen} />
          <Cctv frames={frames} />
        </div>
      </div>
      <Message screen={screen} spoken={spoken} speaking={speaking} />
      <Dialogs dialog={dialog} setDialog={setDialog} manualPlate={screen.manualPlate} />
    </main>
  );
}
