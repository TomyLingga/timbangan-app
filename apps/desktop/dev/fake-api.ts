// A stand-in for the weighbridge routes of apps/api, for tests and for running the program on a laptop. Same
// paths, header, shapes, status codes and sentences as apps/api/src/weighing/{routes,messages,speech,flow}.ts and
// exceptions/decide.ts; the weighing rules are reduced to what a scenario needs: a plate check with retries, and
// one optional check per truck that asks for a decision. Also serves the plate reader's GET /plate/:n.
// Self-contained (node:http only) and written so Node can run it with type stripping.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeCheck = "GROSS_IN" | "TARE_OUT" | "NET_IN" | "NET_OUT";
export type FakeDecision = "APPROVE" | "REJECT" | "OK" | "ADD_LOAD" | "REDUCE_LOAD";

export interface FakeTruck {
  cardUid: string;
  tripId: number;
  tripNo: string;
  direction: "IN" | "OUT";
  /** Letters and digits, as the API keeps them. */
  plateNo: string;
  plateDisplay: string;
  driverName: string;
  partnerName: string;
  stage: 1 | 2;
  /** Not ready: the card is refused with NOT_READY naming this step. */
  waitingStep?: { code: string; name: string } | null;
  /** The station does not serve this direction: WRONG_STATION. */
  wrongStation?: boolean;
  /** A check that fails after the plate, asking for a decision. */
  check?: FakeCheck | null;
}

export interface FakeApiOptions {
  stationKey: string;
  pin?: string | null;
  plateAttempts?: number;
  cameraWeigh1?: number | null;
  cameraWeigh2?: number | null;
  trucks: FakeTruck[];
  /** "off" answers 204 like TTS_ENGINE=off; "tone" answers a short WAV. */
  speech?: "off" | "tone";
  /** Decide every waiting request by itself after this many heartbeats (for the demo). */
  autoDecide?: { afterHeartbeats: number; decision: FakeDecision } | null;
  /** Plate-reader text per camera number. */
  plates?: Record<number, string>;
  now?: () => number;
  port?: number;
  /** POST /__dev/plate/:camera { plate } changes the plate reader's text; for the demo run only. */
  devControl?: boolean;
}

interface FakeWeighing {
  id: number;
  tripId: number;
  stage: 1 | 2;
  kind: "GROSS" | "TARE";
  weightKg: number;
  weighedAt: string;
  mode: "AUTO" | "EXCEPTION";
  plateRead: string | null;
  plateCheck: "MATCH" | "CONFIRMED";
  status: "VALID";
}

interface FakeException {
  id: number;
  tripId: number;
  type: "PLATE" | FakeCheck;
  status: "PENDING" | "APPROVED" | "REJECTED" | "RETRY" | "CANCELLED" | "EXPIRED";
  decisionCode: FakeDecision | null;
  plateRead: string | null;
  liveWeightKg: number;
  lastBeatAt: number;
  heartbeats: number;
  weighingId: number | null;
  nextExceptionId: number | null;
  cancelReason: string | null;
  plateConfirmed: boolean;
}

export interface FakeCall {
  method: string;
  path: string;
  status: number;
  stationKey: string | null;
  body: unknown;
}

// ---- sentences, as apps/api/src/weighing/messages.ts and speech.ts build them ----

type Piece = string | { plate: string } | { kg: number };
type Sentence = Piece | Piece[];
interface Spoken {
  message: string;
  speech: string[];
}

const DIGIT_WORDS = ["nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"];
const formatKg = (value: number) => (value < 0 ? "-" : "") + String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const plateCharacters = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
const displayPlate = (text: string) => (/\s/.test(text.trim()) ? text.trim().toUpperCase().replace(/\s+/g, " ") : plateCharacters(text).replace(/([A-Z])(?=[0-9])|([0-9])(?=[A-Z])/g, "$1$2 "));
const spellPlate = (text: string) => [...plateCharacters(text)].map((char) => (/[0-9]/.test(char) ? DIGIT_WORDS[Number(char)] : char)).join(" ");
const writeOut = (text: string) => text.replace(/\bkg\b/gi, "kilogram").replace(/\bQC\b/g, "kiu si");
const tidy = (text: string) => text.replace(/\s+/g, " ").replace(/\s+([.,:;?!])/g, "$1").trim();
const shown = (piece: Piece) => (typeof piece === "string" ? piece : "plate" in piece ? displayPlate(piece.plate) : `${formatKg(piece.kg)} kg`);
const spokenPiece = (piece: Piece) => (typeof piece === "string" ? writeOut(piece) : "plate" in piece ? spellPlate(piece.plate) : `${formatKg(piece.kg)} kilogram`);

function say(...sentences: Sentence[]): Spoken {
  const list = sentences.map((sentence) => (Array.isArray(sentence) ? sentence : [sentence])).filter((parts) => parts.length > 0);
  return {
    message: list.map((parts) => tidy(parts.map(shown).join(""))).join(" "),
    speech: list.map((parts) => tidy(parts.map(spokenPiece).join(""))),
  };
}
const join = (...parts: Spoken[]): Spoken => ({ message: parts.map((part) => part.message).join(" "), speech: parts.flatMap((part) => part.speech) });

const WAIT = "Mohon tunggu keputusan atasan.";
const stageWord = (stage: 1 | 2) => (stage === 1 ? "pertama" : "kedua");
const kindWord = (kind: "GROSS" | "TARE") => (kind === "GROSS" ? "bruto" : "tarra");
const kindOf = (direction: "IN" | "OUT", stage: 1 | 2): "GROSS" | "TARE" => ((direction === "IN") === (stage === 1) ? "GROSS" : "TARE");

const text = {
  cardUnknown: () => say("Kartu tidak dikenal."),
  wrongStation: () => say("Truk ini bukan untuk timbangan ini."),
  notReady: (step: string | null) => say("Truk belum siap ditimbang.", ...(step ? [`Langkah sekarang: ${step}.`] : [])),
  card: (plate: string, stage: 1 | 2, kind: "GROSS" | "TARE") => say(["Plat ", { plate }, "."], `Timbang ${stageWord(stage)}, ${kindWord(kind)}.`, "Tunggu berat stabil."),
  saved: (stage: 1 | 2, kind: "GROSS" | "TARE", weightKg: number, next: string) =>
    say(`Timbang ${stageWord(stage)} berhasil.`, [`${kindWord(kind) === "bruto" ? "Bruto" : "Tarra"} `, { kg: weightKg }, "."], `Berikutnya: ${next}.`),
  plateRetry: () => say("Plat belum terbaca sesuai.", "Coba baca plat lagi."),
  pending: (type: FakeException["type"], plateRead: string | null, registered: string, weightKg: number): Spoken => {
    switch (type) {
      case "PLATE":
        return say("Plat tidak sesuai.", plateRead ? ["Terbaca ", { plate: plateRead }, "."] : "Plat tidak terbaca.", ["Terdaftar ", { plate: registered }, "."], WAIT);
      case "GROSS_IN":
        return say("Selisih bruto melewati toleransi.", ["Timbang ", { kg: weightKg }, ", surat ", { kg: 41_000 }, "."], WAIT);
      case "TARE_OUT":
        return say("Tarra berbeda dengan tarra master.", ["Timbang ", { kg: weightKg }, ", master ", { kg: 15_000 }, "."], WAIT);
      case "NET_IN":
        return say("Selisih netto melewati toleransi.", ["Netto ", { kg: weightKg }, ", surat ", { kg: 31_000 }, "."], WAIT);
      default:
        return say("Netto perlu diperiksa atasan.", ["Netto ", { kg: weightKg }, "."], WAIT);
    }
  },
  waiting: () => say(WAIT),
  rejected: (plate: boolean) => say("Permintaan ditolak.", plate ? "Supir ke pos registrasi." : "Timbang tidak disimpan."),
  retry: (code: "ADD_LOAD" | "REDUCE_LOAD") => say(code === "ADD_LOAD" ? "Muatan perlu ditambah." : "Muatan perlu dikurangi.", "Timbang tidak disimpan.", "Kembali ke tempat muat."),
  cancelled: () => say("Permintaan dibatalkan.", "Truk belum menimbang."),
  approved: () => say("Permintaan disetujui."),
  manualPlateOpen: () => say("Mode ketik plat dibuka."),
  pinWrong: (left: number) => say("PIN salah.", `Sisa ${left} kali.`),
  pinLocked: () => say("PIN terkunci sementara.", "Coba lagi nanti."),
  pinNotSet: () => say("PIN stasiun belum diatur."),
};

class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
const fail = (status: number, code: string, spoken: Spoken, extra: Record<string, unknown> = {}) => new HttpError(status, { error: { code, message: spoken.message, speech: spoken.speech, ...extra } });
const invalid = (field: string, message: string) => new HttpError(400, { error: { code: "VALIDATION", message: "Data yang dikirim tidak valid.", fields: [{ field, message }] } });

/** A WAV of a short quiet tone: 0.25 s, 440 Hz, 16-bit mono, 16 kHz. */
export function toneWav(): Buffer {
  const rate = 16_000;
  const samples = rate / 4;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3_000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const HEARTBEAT_TIMEOUT_MS = 10_000;
const PIN_MAX_FAILURES = 5;

export interface FakeApi {
  url: string;
  close(): Promise<void>;
  /** What the supervisor does in the approvals app: POST /api/exceptions/:id/decide. */
  decide(id: number, decision: FakeDecision): void;
  setPlate(camera: number, plate: string): void;
  calls: FakeCall[];
  weighings: FakeWeighing[];
  exceptions: FakeException[];
  trucks: FakeTruck[];
}

export async function startFakeApi(options: FakeApiOptions): Promise<FakeApi> {
  const now = options.now ?? (() => Date.now());
  const plateAttempts = options.plateAttempts ?? 3;
  const trucks = options.trucks.map((truck) => ({ ...truck }));
  const plates = new Map<number, string>(Object.entries(options.plates ?? {}).map(([camera, plate]) => [Number(camera), plate]));
  const weighings: FakeWeighing[] = [];
  const exceptions: FakeException[] = [];
  const calls: FakeCall[] = [];
  const stored = new Map<string, { status: number; body: unknown }>();
  const plateRetries = new Map<string, number>();
  let pinFailures = 0;
  let pinLockedUntil = 0;
  let nextId = 100;

  const tripView = (truck: FakeTruck) => {
    const mine = weighings.filter((row) => row.tripId === truck.tripId);
    const gross = mine.find((row) => row.kind === "GROSS")?.weightKg ?? null;
    const tare = mine.find((row) => row.kind === "TARE")?.weightKg ?? null;
    return {
      id: truck.tripId,
      tripNo: truck.tripNo,
      status: mine.length ? "IN_PROCESS" : "CHECKED_IN",
      outcome: null,
      direction: truck.direction,
      flowCode: truck.direction === "IN" ? "CPO_IN" : "CPO_OUT",
      currentStep: truck.waitingStep?.code ?? (truck.stage === 1 ? "WEIGH_1" : "WEIGH_2"),
      plateNo: truck.plateNo,
      plateDisplay: truck.plateDisplay,
      driverName: truck.driverName,
      partner: { id: 1, name: truck.partnerName },
      transporter: null,
      qtyPlanned: null,
      docGrossKg: 41_000,
      docNetKg: 31_000,
      grossKg: gross,
      tareKg: tare,
      netKg: gross !== null && tare !== null ? gross - tare : null,
      allocations: [],
    };
  };

  /** The truck of a card at its weighing step, refused as the API refuses it. */
  const truckOf = (uidText: string): FakeTruck => {
    const uid = uidText.toUpperCase().replace(/[\s:.-]/g, "");
    if (!/^[0-9A-F]{8,20}$/.test(uid)) throw fail(404, "CARD_UNKNOWN", text.cardUnknown());
    const truck = trucks.find((row) => row.cardUid === uid);
    if (!truck) throw fail(404, "CARD_UNKNOWN", text.cardUnknown());
    if (truck.wrongStation) throw fail(409, "WRONG_STATION", text.wrongStation());
    if (truck.waitingStep) throw fail(409, "NOT_READY", text.notReady(truck.waitingStep.name), { waitingStep: truck.waitingStep.code });
    return truck;
  };

  const expire = () => {
    for (const row of exceptions) {
      if (row.status === "PENDING" && now() - row.lastBeatAt > HEARTBEAT_TIMEOUT_MS) {
        row.status = "CANCELLED";
        row.cancelReason = "TIMEOUT";
      }
    }
  };

  const save = (truck: FakeTruck, weightKg: number, plateRead: string | null, mode: "AUTO" | "EXCEPTION", plateCheck: "MATCH" | "CONFIRMED") => {
    const stage = truck.stage;
    const kind = kindOf(truck.direction, stage);
    const row: FakeWeighing = { id: nextId++, tripId: truck.tripId, stage, kind, weightKg, weighedAt: new Date(now()).toISOString(), mode, plateRead, plateCheck, status: "VALID" };
    weighings.push(row);
    plateRetries.delete(`${truck.tripId}:${stage}`);
    // the steps in between are done elsewhere; until then the card is refused here
    truck.waitingStep = stage === 1 ? { code: "QC", name: "QC" } : { code: "CHECK_OUT", name: "Pengembalian kartu" };
    if (stage === 1) truck.stage = 2;
    truck.check = null;
    const next = stage === 1 ? "QC" : "Pengembalian kartu";
    return { row, spoken: text.saved(stage, kind, weightKg, next) };
  };

  const raise = (truck: FakeTruck, type: FakeException["type"], weightKg: number, plateRead: string | null, plateConfirmed: boolean) => {
    const row: FakeException = {
      id: nextId++,
      tripId: truck.tripId,
      type,
      status: "PENDING",
      decisionCode: null,
      plateRead,
      liveWeightKg: weightKg,
      lastBeatAt: now(),
      heartbeats: 0,
      weighingId: null,
      nextExceptionId: null,
      cancelReason: null,
      plateConfirmed,
    };
    exceptions.push(row);
    return row;
  };

  const pendingBody = (row: FakeException, truck: FakeTruck) => ({ result: "PENDING", exception: { id: row.id, type: row.type }, ...text.pending(row.type, row.plateRead, truck.plateNo, row.liveWeightKg) });
  const truckOfTrip = (tripId: number) => trucks.find((row) => row.tripId === tripId) as FakeTruck;

  const decide = (id: number, decision: FakeDecision) => {
    const row = exceptions.find((item) => item.id === id);
    if (!row || row.status !== "PENDING") throw new Error(`Request ${id} is not waiting.`);
    const truck = truckOfTrip(row.tripId);
    row.decisionCode = decision;
    if (decision === "REJECT") {
      row.status = "REJECTED";
      return;
    }
    if (decision === "ADD_LOAD" || decision === "REDUCE_LOAD") {
      row.status = "RETRY";
      truck.waitingStep = { code: "LOADING", name: "Muat" };
      return;
    }
    row.status = "APPROVED";
    if (row.type === "PLATE" && truck.check) {
      row.nextExceptionId = raise(truck, truck.check, row.liveWeightKg, row.plateRead, true).id;
      return;
    }
    row.weighingId = save(truck, row.liveWeightKg, row.plateRead, "EXCEPTION", row.type === "PLATE" || row.plateConfirmed ? "CONFIRMED" : "MATCH").row.id;
  };

  /** The answer of exceptions/decide.ts stationAnswer. */
  const stationAnswer = (row: FakeException) => {
    const decision = row.status === "RETRY" ? row.decisionCode : row.status === "APPROVED" ? (row.type === "NET_OUT" ? "OK" : "APPROVE") : row.status === "REJECTED" ? "REJECT" : null;
    const head = { status: row.status, ...(decision ? { decision } : {}) };
    if (row.status === "PENDING") return { status: row.status, ...text.waiting() };
    const truck = truckOfTrip(row.tripId);
    if (row.status === "APPROVED" && row.weighingId !== null) {
      const weighing = weighings.find((item) => item.id === row.weighingId) as FakeWeighing;
      const next = weighing.stage === 1 ? "QC" : "Pengembalian kartu";
      return { ...head, result: "SAVED", weighing, trip: tripView(truck), ...join(text.approved(), text.saved(weighing.stage, weighing.kind, weighing.weightKg, next)) };
    }
    if (row.status === "APPROVED" && row.nextExceptionId !== null) {
      const next = exceptions.find((item) => item.id === row.nextExceptionId) as FakeException;
      return { ...head, result: "PENDING", exception: { id: next.id, type: next.type }, ...join(text.approved(), text.pending(next.type, next.plateRead, truck.plateNo, next.liveWeightKg)) };
    }
    if (row.status === "REJECTED") return { ...head, result: "NOT_SAVED", ...text.rejected(row.type === "PLATE") };
    if (row.status === "RETRY" && (row.decisionCode === "ADD_LOAD" || row.decisionCode === "REDUCE_LOAD")) return { ...head, result: "NOT_SAVED", ...text.retry(row.decisionCode) };
    return { ...head, result: "NOT_SAVED", ...text.cancelled() };
  };

  const weightOf = (value: unknown, positive: boolean) => {
    if (typeof value !== "number" || !Number.isInteger(value)) throw invalid("weightKg", "Berat harus kilogram bulat.");
    if (positive ? value <= 0 : value < 0) throw invalid("weightKg", positive ? "Berat harus lebih dari 0." : "Berat tidak boleh negatif.");
    if (value > 200_000) throw invalid("weightKg", "Berat terlalu besar.");
    return value;
  };

  async function route(method: string, path: string, query: URLSearchParams, body: unknown, key: string | null): Promise<{ status: number; body?: unknown; wav?: Buffer }> {
    if (method === "GET" && path === "/api/health") return { status: 200, body: { status: "ok", database: "up", version: "fake" } };
    const plate = /^\/plate\/(\d+)$/.exec(path);
    if (method === "GET" && plate) {
      const camera = Number(plate[1]);
      if (!plates.has(camera)) return { status: 404, body: { detail: `unknown camera ${camera}` } };
      return { status: 200, body: { plate: plates.get(camera), raw: plates.get(camera), fps: 8, status: "online" } };
    }
    const control = /^\/__dev\/plate\/(\d+)$/.exec(path);
    if (options.devControl && method === "POST" && control) {
      plates.set(Number(control[1]), String((body as { plate?: unknown } | null)?.plate ?? ""));
      return { status: 204 };
    }
    if (!path.startsWith("/api/weighbridge/")) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Alamat tidak ditemukan." } } };
    if (key !== options.stationKey) throw new HttpError(401, { error: { code: "STATION_UNAUTHENTICATED", message: "Kunci stasiun tidak valid.", speech: ["Kunci stasiun tidak valid."] } });
    expire();

    const card = /^\/api\/weighbridge\/card\/([^/]+)$/.exec(path);
    if (method === "GET" && card) {
      const truck = truckOf(decodeURIComponent(card[1] ?? ""));
      const kind = kindOf(truck.direction, truck.stage);
      return {
        status: 200,
        body: {
          trip: tripView(truck),
          stage: truck.stage,
          kind,
          camera: (truck.stage === 1 ? options.cameraWeigh1 : options.cameraWeigh2) ?? null,
          expected: { plateNo: truck.plateNo, plateDisplay: truck.plateDisplay, docGrossKg: 41_000, docNetKg: 31_000, vehicleTareKg: null },
          ...text.card(truck.plateDisplay, truck.stage, kind),
        },
      };
    }

    if (method === "POST" && path === "/api/weighbridge/weigh") {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.cardUid !== "string" || !input.cardUid.trim()) throw invalid("cardUid", "UID kartu wajib diisi.");
      const weightKg = weightOf(input.weightKg, true);
      const plateRead = input.plateRead === undefined || input.plateRead === null ? null : String(input.plateRead).trim();
      if (typeof input.requestId !== "string" || !/^[A-Za-z0-9._:-]{8,64}$/.test(input.requestId)) throw invalid("requestId", "Nomor permintaan tidak valid.");
      const known = stored.get(input.requestId);
      if (known) return known;
      const truck = truckOf(input.cardUid);
      const open = exceptions.find((row) => row.tripId === truck.tripId && row.status === "PENDING");
      let answer: { status: number; body: unknown };
      if (open) {
        open.liveWeightKg = weightKg;
        open.lastBeatAt = now();
        answer = { status: 202, body: pendingBody(open, truck) };
      } else if (plateCharacters(plateRead ?? "") !== truck.plateNo) {
        const retryKey = `${truck.tripId}:${truck.stage}`;
        const attempt = (plateRetries.get(retryKey) ?? 0) + 1;
        if (attempt < plateAttempts) {
          plateRetries.set(retryKey, attempt);
          answer = { status: 200, body: { result: "PLATE_RETRY", attemptsLeft: plateAttempts - attempt, ...text.plateRetry() } };
        } else {
          plateRetries.delete(retryKey);
          answer = { status: 202, body: pendingBody(raise(truck, "PLATE", weightKg, plateRead, false), truck) };
        }
      } else if (truck.check) {
        answer = { status: 202, body: pendingBody(raise(truck, truck.check, weightKg, plateRead, false), truck) };
      } else {
        const { row, spoken } = save(truck, weightKg, plateRead, "AUTO", "MATCH");
        answer = { status: 200, body: { result: "SAVED", weighing: row, trip: tripView(truck), ...spoken } };
      }
      stored.set(input.requestId, answer);
      return answer;
    }

    const exception = /^\/api\/weighbridge\/exceptions\/(\d+)\/(heartbeat|cancel)$/.exec(path);
    if (method === "POST" && exception) {
      const row = exceptions.find((item) => item.id === Number(exception[1]));
      const input = (body ?? {}) as Record<string, unknown>;
      if (exception[2] === "heartbeat") {
        const weightKg = weightOf(input.weightKg, false);
        if (!row) throw fail(404, "NOT_FOUND", say("Permintaan tidak ditemukan."));
        if (row.status === "PENDING") {
          row.liveWeightKg = weightKg;
          row.lastBeatAt = now();
          row.heartbeats++;
          if (options.autoDecide && row.heartbeats >= options.autoDecide.afterHeartbeats) {
            const wanted = options.autoDecide.decision;
            decide(row.id, row.type === "NET_OUT" ? wanted : wanted === "OK" ? "APPROVE" : wanted);
          }
        }
        return { status: 200, body: stationAnswer(row) };
      }
      if (input.reason !== "TRUCK_LEFT" && input.reason !== "OPERATOR") throw invalid("reason", "Alasan harus TRUCK_LEFT atau OPERATOR.");
      if (!row) throw fail(404, "NOT_FOUND", say("Permintaan tidak ditemukan."));
      if (row.status === "PENDING") {
        row.status = "CANCELLED";
        row.cancelReason = input.reason;
      } else if (row.status !== "CANCELLED" && row.status !== "EXPIRED") {
        throw fail(409, "ALREADY_DECIDED", say("Permintaan ini sudah diputuskan."));
      }
      return { status: 200, body: { status: "CANCELLED", ...text.cancelled() } };
    }

    if (method === "POST" && path === "/api/weighbridge/manual-plate") {
      const pin = (body as { pin?: unknown } | null)?.pin;
      if (typeof pin !== "string" || !/^[0-9]{4,8}$/.test(pin)) throw invalid("pin", "PIN harus 4 sampai 8 angka.");
      if (!options.pin) throw fail(409, "PIN_NOT_SET", text.pinNotSet());
      if (pinLockedUntil > now()) throw fail(429, "PIN_LOCKED", text.pinLocked(), { lockedUntil: new Date(pinLockedUntil).toISOString() });
      if (pin === options.pin) {
        pinFailures = 0;
        return { status: 200, body: { unlocked: true, ...text.manualPlateOpen() } };
      }
      pinFailures++;
      if (pinFailures >= PIN_MAX_FAILURES) {
        pinFailures = 0;
        pinLockedUntil = now() + 5 * 60_000;
        throw fail(429, "PIN_LOCKED", text.pinLocked(), { lockedUntil: new Date(pinLockedUntil).toISOString() });
      }
      throw fail(403, "PIN_WRONG", text.pinWrong(PIN_MAX_FAILURES - pinFailures), { attemptsLeft: PIN_MAX_FAILURES - pinFailures });
    }

    if (method === "GET" && path === "/api/weighbridge/speech") {
      const spoken = (query.get("text") ?? "").trim();
      if (!spoken) throw invalid("text", "Teks wajib diisi.");
      if (spoken.length > 300) throw invalid("text", "Teks terlalu panjang.");
      if ((options.speech ?? "off") === "off") return { status: 204 };
      return { status: 200, wav: toneWav() };
    }

    return { status: 404, body: { error: { code: "NOT_FOUND", message: "Alamat tidak ditemukan." } } };
  }

  const readBody = (request: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(Symbol.for("invalid-json"));
        }
      });
    });

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const method = request.method ?? "GET";
    const header = request.headers["x-station-key"];
    const key = typeof header === "string" ? header.trim() : null;
    const body = method === "POST" ? await readBody(request) : null;
    let status = 500;
    try {
      if (body === Symbol.for("invalid-json")) throw new HttpError(400, { error: { code: "BAD_REQUEST", message: "Permintaan tidak dapat dibaca." } });
      const answer = await route(method, url.pathname, url.searchParams, body, key);
      status = answer.status;
      if (answer.wav) {
        response.writeHead(status, { "content-type": "audio/wav", "content-length": answer.wav.length });
        response.end(answer.wav);
      } else if (answer.body === undefined) {
        response.writeHead(status);
        response.end();
      } else {
        response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(answer.body));
      }
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, { error: { code: "INTERNAL", message: "Terjadi kesalahan di server." } });
      status = known.status;
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(known.body));
    }
    calls.push({ method, path: url.pathname, status, stationKey: key, body });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "localhost", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    decide,
    setPlate: (camera: number, value: string) => plates.set(camera, value),
    calls,
    weighings,
    exceptions,
    trucks,
  };
}
