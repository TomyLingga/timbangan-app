// Mock of the control room part of the API (apps/api src/control-room), with a scripted day: trucks move between
// zones every few seconds, one waits for a weighbridge decision, one is held by QC, one has waited long in the
// staging zone. Node only, no dependencies. Every plate and number here is made up.
//
//   node dev/mock-control-room.mjs
//
// It answers just enough of the rest of the API for the page to open: POST /api/auth/refresh (always signed in),
// GET /api/me (a staff account holding dashboard VIEW), POST /api/auth/logout, GET /api/health. dev/mock-api.mjs
// imports `controlRoomRoutes()` and passes its own sign-in check.
//
// Environment:
//   PORT           port to listen on (default 3120)
//   HOST           interface to bind (default localhost)
//   WEB_ORIGIN     origin of the web app, for CORS (default http://localhost:3000)
//   MOCK_TICK_MS   how often the day moves on (default 4000; 0 moves only on POST /__mock/tick)
//   MOCK_PLAN      "demo" (default) or "real": the drawing, the picture and the zone polygons from MOCK_PLAN_DIR.
//                  The demo plan has a made-up picture drawn here in code; "real" reads the picture plan.json names.
//   MOCK_PLAN_DIR  folder with plan.json, its drawing and its picture (default <repository>/.data/plan, which git
//                  ignores)
//
// Helpers the real API does not have:
//   POST /__mock/tick   moves the day on by one step now

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const PORT = Number(process.env.PORT ?? 3120);
const HOST = process.env.HOST ?? "localhost";
const WEB_ORIGIN = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
const TICK_MS = Number(process.env.MOCK_TICK_MS ?? 4000);
const PLAN_MODE = process.env.MOCK_PLAN === "real" ? "real" : "demo";
const PLAN_DIR = process.env.MOCK_PLAN_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.data/plan");
const TOKEN = "mock-control-room-token";
const LONG_AGO_MIN = 95;

// --- the plan ---------------------------------------------------------------------------------------------------

// The made-up demo plant of apps/api src/control-room/demo-plan.ts.
const DEMO_PLAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 560" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round">
  <title>Denah contoh</title>
  <g class="plan-boundary" stroke-width="1.4"><path d="M800 540 H40 Q20 540 20 520 V40 Q20 20 40 20 H960 Q980 20 980 40 V520 Q980 540 960 540 H860" /></g>
  <g class="plan-road" stroke-opacity="0.55">
    <rect x="50" y="50" width="900" height="460" rx="30" /><rect x="76" y="76" width="848" height="408" rx="16" />
    <path d="M440 76 V484 M466 76 V306 M466 334 V484 M466 306 H924 M466 334 H924" /><path d="M810 510 V540 M850 510 V540" />
  </g>
  <g class="plan-bund" stroke-dasharray="4 4" stroke-opacity="0.6"><rect x="96" y="96" width="328" height="128" rx="6" /></g>
  <g class="plan-tank"><circle cx="140" cy="160" r="34" /><circle cx="210" cy="160" r="30" /><circle cx="275" cy="160" r="30" /><circle cx="340" cy="160" r="30" /><circle cx="396" cy="160" r="20" /></g>
  <g class="plan-building">
    <rect x="490" y="96" width="140" height="120" rx="4" /><path d="M490 136 H630 M560 96 V216" stroke-opacity="0.5" />
    <rect x="700" y="190" width="200" height="100" rx="4" /><path d="M700 240 H900" stroke-opacity="0.5" />
    <rect x="690" y="96" width="210" height="70" rx="4" /><rect x="110" y="266" width="64" height="92" rx="4" />
    <rect x="500" y="420" width="140" height="56" rx="4" /><rect x="110" y="400" width="80" height="60" rx="4" />
  </g>
  <g class="plan-weighbridge" stroke-width="1.2"><rect x="592" y="352" width="76" height="30" rx="2" /><path d="M604 352 V382 M616 352 V382 M628 352 V382 M640 352 V382 M652 352 V382" stroke-opacity="0.5" /></g>
</svg>
`;

const box = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
const DEMO_SHAPES = {
  REG: box(0.79, 0.8, 0.87, 0.95),
  QUEUE: box(0.7, 0.62, 0.9, 0.78),
  WB: box(0.58, 0.61, 0.68, 0.7),
  QC: box(0.49, 0.61, 0.555, 0.7),
  STAGING: box(0.3, 0.44, 0.42, 0.8),
  DOCK: box(0.58, 0.34, 0.68, 0.42),
  SEAL: box(0.58, 0.45, 0.68, 0.53),
  LOADING: box(0.19, 0.67, 0.27, 0.84),
  UNLOADING: box(0.19, 0.46, 0.27, 0.63),
};

/** A PNG file from RGB rows. */
function encodePng(width, height, rgb) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9); // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A made-up picture of the demo plant, in the manner of a light CAD print: grey roads and roofs, dark outlines and
 * tank rings on white, laid out like DEMO_PLAN_SVG. Nothing here comes from the real site.
 */
function demoPicture() {
  const width = 1000;
  const height = 560;
  const rgb = Buffer.alloc(width * height * 3, 255);
  const dot = (x, y, shade) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    rgb.fill(shade, (y * width + x) * 3, (y * width + x) * 3 + 3);
  };
  const fill = (x1, y1, x2, y2, shade) => {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) dot(x, y, shade);
  };
  const outline = (x1, y1, x2, y2, shade, thick = 1) => {
    fill(x1, y1, x2, y1 + thick, shade);
    fill(x1, y2 - thick, x2, y2, shade);
    fill(x1, y1, x1 + thick, y2, shade);
    fill(x2 - thick, y1, x2, y2, shade);
  };
  const ring = (cx, cy, r, shade) => {
    for (let y = cy - r - 1; y <= cy + r + 1; y++) {
      for (let x = cx - r - 1; x <= cx + r + 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (Math.abs(d - r) < 0.9) dot(x, y, shade);
      }
    }
  };
  outline(20, 20, 980, 540, 60, 2);
  // roads
  fill(50, 50, 950, 76, 214);
  fill(50, 484, 950, 510, 214);
  fill(50, 50, 76, 510, 214);
  fill(924, 50, 950, 510, 214);
  fill(440, 76, 466, 484, 214);
  fill(466, 306, 924, 334, 214);
  fill(810, 510, 850, 540, 214);
  // tank farm
  outline(96, 96, 424, 224, 120);
  for (const [cx, r] of [[140, 34], [210, 30], [275, 30], [340, 30], [396, 20]]) ring(cx, 160, r, 70);
  // buildings
  for (const [x1, y1, x2, y2] of [[490, 96, 630, 216], [700, 190, 900, 290], [690, 96, 900, 166], [110, 266, 174, 358], [500, 420, 640, 476], [110, 400, 190, 460]]) {
    fill(x1, y1, x2, y2, 232);
    outline(x1, y1, x2, y2, 70);
  }
  // weighbridge
  fill(592, 352, 668, 382, 190);
  outline(592, 352, 668, 382, 40, 2);
  for (let x = 604; x < 668; x += 12) fill(x, 352, x + 1, 382, 120);
  return { bytes: encodePng(width, height, rgb), type: "image/png", width, height };
}

/** Width and height of a PNG from its header. */
const pngSize = (bytes) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

function loadPlan() {
  if (PLAN_MODE === "demo") return { svg: DEMO_PLAN_SVG, shapes: DEMO_SHAPES, image: demoPicture() };
  const plan = JSON.parse(readFileSync(path.join(PLAN_DIR, "plan.json"), "utf8"));
  let image = null;
  if (typeof plan.image === "string") {
    const bytes = readFileSync(path.resolve(PLAN_DIR, plan.image));
    const isPng = bytes.subarray(0, 4).toString("hex") === "89504e47";
    if (!isPng) throw new Error("The mock reads PNG plan pictures only.");
    image = { bytes, type: "image/png", ...pngSize(bytes) };
  }
  return { svg: readFileSync(path.resolve(PLAN_DIR, plan.svg), "utf8"), shapes: plan.zones, image };
}
const plan = loadPlan();
// MOCK_PLAN_IMAGE=off leaves the picture out, to see the line drawing the page falls back to
if (process.env.MOCK_PLAN_IMAGE === "off") plan.image = null;
const planImage = plan.image
  ? { width: plan.image.width, height: plan.image.height, version: createHash("sha256").update(plan.image.bytes).digest("hex").slice(0, 16) }
  : null;

// The zones and colours of apps/api migrations/0002_seed.sql.
const ZONES = [
  ["REG", "Pos registrasi (scan barcode, ambil dan kembalikan kartu)", "REGISTRATION", "#e53935"],
  ["QUEUE", "Parkir antrean timbang", "QUEUE_PARKING", "#9ccc65"],
  ["WB", "Timbangan", "WEIGHBRIDGE", "#fdd835"],
  ["QC", "QC pass", "QC", "#4fc3f7"],
  ["STAGING", "Parkir sebelum muat/bongkar, cek kebersihan dan najis", "STAGING", "#1e3a8a"],
  ["DOCK", "Loading dock produk ritel kemasan", "DOCK", "#2e7d32"],
  ["LOADING", "Loading", "LOADING", "#8e24aa"],
  ["UNLOADING", "Unloading", "UNLOADING", "#f48fb1"],
  ["SEAL", "Locis segel", "SEALING", "#fb8c00"],
].map(([code, name, kind, color]) => ({ code, name, kind, color, shape: plan.shapes[code] ?? null }));

// The flow steps of the seed: code, name, waiting zone, work zone.
const FLOWS = {
  IN_CPO: [
    ["CHECK_IN", "Scan SPJ dan ambil kartu", "REG", "REG"],
    ["SEAL_CHECK", "Cek segel", "SEAL", "SEAL"],
    ["WEIGH_1", "Timbang 1 (bruto)", "QUEUE", "WB"],
    ["QC", "QC pass", "QC", "QC"],
    ["UNLOADING", "Bongkar", "STAGING", "UNLOADING"],
    ["TANK_CHECK", "Cek tangki kosong", "UNLOADING", "UNLOADING"],
    ["WEIGH_2", "Timbang 2 (tarra)", "QUEUE", "WB"],
    ["CHECK_OUT", "Kembalikan kartu", "REG", "REG"],
  ],
  IN_GOODS: [
    ["CHECK_IN", "Scan SPJ dan ambil kartu", "REG", "REG"],
    ["WEIGH_1", "Timbang 1 (bruto)", "QUEUE", "WB"],
    ["QC", "QC barang", "STAGING", "STAGING"],
    ["UNLOADING", "Bongkar di gudang", "STAGING", "DOCK"],
    ["WEIGH_2", "Timbang 2 (tarra)", "QUEUE", "WB"],
    ["CHECK_OUT", "Kembalikan kartu", "REG", "REG"],
  ],
  OUT_BULK: [
    ["CHECK_IN", "Scan SPJ dan ambil kartu", "REG", "REG"],
    ["WEIGH_1", "Timbang 1 (tarra)", "QUEUE", "WB"],
    ["CLEANLINESS", "Cek kebersihan dan najis", "STAGING", "STAGING"],
    ["QC_LOADING", "QC loading", "STAGING", "LOADING"],
    ["LOADING", "Muat", "LOADING", "LOADING"],
    ["SEALING", "Segel (locis)", "SEAL", "SEAL"],
    ["WEIGH_2", "Timbang 2 (bruto)", "QUEUE", "WB"],
    ["CHECK_OUT", "Kembalikan kartu", "REG", "REG"],
  ],
  OUT_PACKED: [
    ["CHECK_IN", "Scan SPJ dan ambil kartu", "REG", "REG"],
    ["WEIGH_1", "Timbang 1 (tarra)", "QUEUE", "WB"],
    ["CLEANLINESS", "Cek kebersihan dan najis", "STAGING", "STAGING"],
    ["LOADING", "Muat di loading dock", "STAGING", "DOCK"],
    ["SEALING", "Segel", "SEAL", "SEAL"],
    ["WEIGH_2", "Timbang 2 (bruto)", "QUEUE", "WB"],
    ["CHECK_OUT", "Kembalikan kartu", "REG", "REG"],
  ],
};
const WEIGH = new Set(["WEIGH_1", "WEIGH_2"]);
const FLOW_CODES = Object.keys(FLOWS);

// --- the scripted day ------------------------------------------------------------------------------------------

let seed = 20261121;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const now = () => new Date().toISOString();

let nextTrip = 501;
let nextPlate = 2001;
const trucks = [];
const finished = [];
const upcoming = { in: 6, out: 4 };

function newTruck(flow, { checkedInMinutesAgo = 0 } = {}) {
  const tripId = nextTrip++;
  const letters = ["AA", "AB", "AC", "BA", "BB", "CA", "CB", "DA"][tripId % 8];
  const truck = {
    tripId,
    tripNo: `TRP-${String(tripId).padStart(5, "0")}`,
    plateDisplay: `ZZ ${nextPlate++} ${letters}`,
    direction: flow.startsWith("IN") ? "IN" : "OUT",
    flowCode: flow,
    checkedInAt: minutesAgo(checkedInMinutesAgo),
    held: null,
    frozen: false,
    weighings: [],
    exceptions: [],
    steps: FLOWS[flow].map(([code, name, wait, work], index) => ({
      code, name, wait, work, status: index === 0 ? "DONE" : index === 1 ? "READY" : "PENDING", result: index === 0 ? "PASS" : null,
      readyAt: index <= 1 ? minutesAgo(checkedInMinutesAgo) : null,
      startedAt: index === 0 ? minutesAgo(checkedInMinutesAgo) : null,
      finishedAt: index === 0 ? minutesAgo(checkedInMinutesAgo) : null,
    })),
  };
  trucks.push(truck);
  return truck;
}

const activeStep = (truck) => truck.steps.find((step) => step.status === "READY" || step.status === "IN_PROGRESS") ?? null;

/** Moves one truck on by one transition; `at` is the time of the change. */
function advance(truck, at = now()) {
  const step = activeStep(truck);
  if (!step) return;
  if (step.status === "READY" && !WEIGH.has(step.code) && step.code !== "CHECK_OUT") {
    step.status = "IN_PROGRESS";
    step.startedAt = at;
    return;
  }
  step.status = "DONE";
  step.result = "PASS";
  step.startedAt ??= at;
  step.finishedAt = at;
  if (WEIGH.has(step.code)) {
    const stage = step.code === "WEIGH_1" ? 1 : 2;
    const gross = (truck.direction === "IN") === (stage === 1);
    truck.weighings.push({ stage, kind: gross ? "GROSS" : "TARE", kg: gross ? 28_000 + Math.round(random() * 6_000) : 11_000 + Math.round(random() * 2_000), at, mode: "AUTO", plateCheck: "MATCH", status: "VALID" });
  }
  if (step.code === "CHECK_OUT") {
    trucks.splice(trucks.indexOf(truck), 1);
    finished.push({ minutes: (Date.parse(at) - Date.parse(truck.checkedInAt)) / 60_000 });
    return;
  }
  const next = truck.steps.find((item) => item.status === "PENDING");
  if (next) {
    next.status = "READY";
    next.readyAt = at;
  }
}

function setUpDay() {
  // trucks already inside, at different steps
  for (let index = 0; index < 14; index++) {
    const flow = FLOW_CODES[index % FLOW_CODES.length];
    const checkedIn = 78 - index * 5;
    const truck = newTruck(flow, { checkedInMinutesAgo: checkedIn });
    // one change every 3 minutes after check-in, the last one at least a minute ago, never as far as the exit
    const moves = Math.min((index * 3) % (truck.steps.length * 2 - 4), Math.floor((checkedIn - 1) / 3));
    for (let move = 1; move <= moves; move++) advance(truck, minutesAgo(checkedIn - move * 3));
  }
  // waiting for a decision on the weighbridge
  const held = newTruck("IN_CPO", { checkedInMinutesAgo: 40 });
  advance(held, minutesAgo(36));
  advance(held, minutesAgo(30));
  held.held = { type: "GROSS_IN", since: minutesAgo(12) };
  held.exceptions.push({ type: "GROSS_IN", status: "PENDING", raisedAt: held.held.since, decidedAt: null, decisionCode: null });
  held.frozen = true;
  // held by QC
  const qc = newTruck("IN_CPO", { checkedInMinutesAgo: 55 });
  advance(qc, minutesAgo(52));
  advance(qc, minutesAgo(47));
  advance(qc, minutesAgo(40));
  advance(qc, minutesAgo(25));
  qc.steps.find((step) => step.code === "QC").result = "HOLD";
  qc.held = { type: "QC_HOLD", since: minutesAgo(18) };
  qc.exceptions.push({ type: "QC_HOLD", status: "PENDING", raisedAt: qc.held.since, decidedAt: null, decisionCode: null });
  qc.frozen = true;
  // waiting long in staging
  const slow = newTruck("OUT_BULK", { checkedInMinutesAgo: LONG_AGO_MIN + 20 });
  advance(slow, minutesAgo(LONG_AGO_MIN));
  slow.frozen = true;
  for (let index = 0; index < 5; index++) finished.push({ minutes: 70 + index * 9 });
}

let cursor = 0;
function tick() {
  const movable = trucks.filter((truck) => !truck.frozen);
  for (let count = 0; count < 2 && movable.length; count++) {
    const truck = movable[cursor++ % movable.length];
    advance(truck);
  }
  // new trucks keep coming: every round while the plant is quiet, every other round until it is full
  if (trucks.length < 12 || (cursor % 4 === 0 && trucks.length < 18)) {
    if (upcoming.in + upcoming.out === 0) Object.assign(upcoming, { in: 4, out: 3 });
    const flow = FLOW_CODES[Math.floor(random() * FLOW_CODES.length)];
    if (flow.startsWith("IN") && upcoming.in > 0) upcoming.in--;
    else if (upcoming.out > 0) upcoming.out--;
    else upcoming.in--;
    newTruck(flow);
  }
  publish();
}

// --- the state, as GET /api/control-room/state answers it ----------------------------------------------------------

function position(truck) {
  const step = activeStep(truck);
  if (truck.held) {
    const zone = truck.held.type === "QC_HOLD" ? "QC" : "WB";
    const since = truck.held.type === "QC_HOLD" && step?.status === "IN_PROGRESS" ? step.startedAt : truck.held.since;
    return { zone, step, since };
  }
  if (step?.status === "IN_PROGRESS") return { zone: step.work, step, since: step.startedAt };
  if (step?.status === "READY") return { zone: step.wait, step, since: step.readyAt };
  return { zone: "REG", step: null, since: truck.checkedInAt };
}

const label = (name) => {
  const text = name.replace(/\s*\([^)]*\)/g, "").trim();
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
};

function recentEvents() {
  const rows = [];
  for (const truck of trucks) {
    for (const step of truck.steps) {
      const base = { tripId: truck.tripId, plateDisplay: truck.plateDisplay, code: step.code, name: step.name };
      if (step.readyAt && step.readyAt !== step.startedAt) rows.push({ ...base, kind: "READY", at: step.readyAt });
      if (step.startedAt && step.startedAt !== step.finishedAt) rows.push({ ...base, kind: "STARTED", at: step.startedAt });
      if (step.finishedAt && step.status === "DONE") rows.push({ ...base, kind: "DONE", at: step.finishedAt });
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at) || a.tripId - b.tripId || a.kind.localeCompare(b.kind));
  const used = new Set();
  const lines = [];
  for (const row of rows) {
    if (used.has(row)) continue;
    used.add(row);
    let text =
      row.kind === "READY" ? `${row.plateDisplay} menunggu ${label(row.name)}`
      : row.kind === "STARTED" ? `${row.plateDisplay} mulai ${label(row.name)}`
      : row.code === "CHECK_IN" ? `${row.plateDisplay} check-in`
      : `${row.plateDisplay} selesai ${label(row.name)}`;
    if (row.kind === "DONE") {
      const next = rows.find((other) => !used.has(other) && other.kind === "READY" && other.tripId === row.tripId && other.at === row.at);
      if (next) {
        used.add(next);
        text += `, menunggu ${label(next.name)}`;
      }
    }
    lines.push({ at: row.at, tripId: row.tripId, plateDisplay: row.plateDisplay, text });
    if (lines.length === 30) break;
  }
  return lines;
}

function buildState() {
  const generatedAt = now();
  const placed = trucks.map((truck) => {
    const { zone, step, since } = position(truck);
    return {
      tripId: truck.tripId,
      tripNo: truck.tripNo,
      plateNo: truck.plateDisplay.replace(/\s/g, ""),
      plateDisplay: truck.plateDisplay,
      direction: truck.direction,
      flowCode: truck.flowCode,
      zone,
      stepCode: step?.code ?? null,
      stepName: step?.name ?? null,
      stepStatus: step?.status ?? null,
      since,
      held: truck.held,
    };
  });
  placed.sort((a, b) => a.since.localeCompare(b.since) || a.tripId - b.tripId);
  const zoneStats = ZONES.map((zone) => {
    const here = placed.filter((truck) => truck.zone === zone.code);
    const first = here[0];
    return {
      zone: zone.code,
      count: here.length,
      longest: first ? { tripId: first.tripId, plateDisplay: first.plateDisplay, minutes: Math.max(0, Math.floor((Date.now() - Date.parse(first.since)) / 60_000)) } : null,
    };
  });
  const pending = trucks.filter((truck) => truck.held).length;
  const avg = finished.length ? Math.round(finished.reduce((sum, item) => sum + item.minutes, 0) / finished.length) : null;
  return {
    generatedAt,
    plantDay: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()),
    planImage,
    zones: ZONES,
    trucks: placed,
    upcoming: { ...upcoming },
    kpi: { inside: placed.length, upcoming: upcoming.in + upcoming.out, pendingDecisions: pending, finishedToday: finished.length, avgMinutesInPlantToday: avg },
    zoneStats,
    recent: recentEvents(),
  };
}

// Made-up papers per flow for the truck detail window: product, partner and contract prefix.
const PAPERS = {
  IN_CPO: { product: "CPO", partner: "PT Pemasok Sawit Contoh", contract: "KTR/BELI/CONTOH" },
  IN_GOODS: { product: "Bahan penolong contoh", partner: "PT Pemasok Bahan Contoh", contract: "KTR/BELI/CONTOH" },
  OUT_BULK: { product: "Olein contoh", partner: "PT Pelanggan Curah Contoh", contract: "SO/CONTOH" },
  OUT_PACKED: { product: "Minyak goreng kemasan contoh", partner: "PT Pelanggan Ritel Contoh", contract: "SO/CONTOH" },
};
const TRANSPORTERS = ["PT Angkutan Contoh Jaya", "CV Truk Contoh Abadi", null];

/** The truck block of GET /api/control-room/trips/:id, made up from the trip id. */
function papers(truck) {
  const paper = PAPERS[truck.flowCode];
  const id = truck.tripId;
  const incoming = truck.direction === "IN";
  const valid = truck.weighings.filter((item) => item.status === "VALID");
  const gross = valid.find((item) => item.kind === "GROSS")?.kg ?? null;
  const tare = valid.find((item) => item.kind === "TARE")?.kg ?? null;
  const twoContracts = id % 3 === 0;
  const allocations = [1, ...(twoContracts ? [2] : [])].map((seq) => ({
    contractNo: `${paper.contract}/${String(id * 2 + seq).padStart(4, "0")}`,
    doNo: incoming ? null : `DO/CONTOH/${String(id * 2 + seq).padStart(4, "0")}`,
  }));
  const letterGross = incoming && truck.flowCode === "IN_CPO" ? 30_000 + (id % 7) * 250 : null;
  const letterTare = letterGross ? 11_800 + (id % 5) * 100 : null;
  return {
    regNo: `REG/CONTOH/${String(id).padStart(4, "0")}`,
    spjNo: `SPJ/CONTOH/${String(id).padStart(5, "0")}`,
    driverName: `Supir Contoh ${id}`,
    transporterName: TRANSPORTERS[id % TRANSPORTERS.length],
    partnerName: paper.partner,
    partnerRole: incoming ? "SUPPLIER" : "CUSTOMER",
    vehicleType: "Truk tangki",
    containerNo: null,
    cardLabel: `K-${String((id % 40) + 1).padStart(2, "0")}`,
    products: [paper.product],
    allocations,
    letter: { grossKg: letterGross, tareKg: letterTare, netKg: letterGross && letterTare ? letterGross - letterTare : null },
    weighed: { grossKg: gross, tareKg: tare, netKg: gross !== null && tare !== null ? gross - tare : null },
  };
}

function timeline(tripId) {
  const truck = trucks.find((item) => item.tripId === tripId);
  if (!truck) return null;
  const minutesOf = (step) => {
    const from = step.readyAt ?? step.startedAt;
    if (!from) return null;
    return Math.max(0, Math.floor(((step.finishedAt ? Date.parse(step.finishedAt) : Date.now()) - Date.parse(from)) / 60_000));
  };
  return {
    trip: { id: truck.tripId, tripNo: truck.tripNo, plateDisplay: truck.plateDisplay, direction: truck.direction, flowCode: truck.flowCode, status: "IN_PROCESS", checkedInAt: truck.checkedInAt, completedAt: null },
    truck: papers(truck),
    steps: truck.steps.map((step) => ({
      code: step.code, name: step.name, status: step.status, result: step.result, readyAt: step.readyAt, startedAt: step.startedAt, finishedAt: step.finishedAt, minutes: minutesOf(step),
    })),
    weighings: truck.weighings,
    exceptions: truck.exceptions,
  };
}

// --- the event stream -----------------------------------------------------------------------------------------------

const listeners = new Set();
let lastFrame = null;

function publish() {
  const state = buildState();
  const { generatedAt, ...rest } = state;
  const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  const fingerprint = JSON.stringify(rest);
  if (fingerprint === lastFrame?.fingerprint) return;
  lastFrame = { fingerprint, frame, generatedAt };
  for (const send of listeners) send(frame);
}

// --- HTTP ------------------------------------------------------------------------------------------------------------

const USER = { id: "u-cr", kind: "INTERNAL", username: "kontrol.contoh", fullName: "Ruang Kontrol Contoh", permissions: { dashboard: "VIEW" }, partner: null };

function cors(response) {
  response.setHeader("access-control-allow-origin", WEB_ORIGIN);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-headers", "authorization, content-type, accept");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("vary", "origin");
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

const signedIn = (request) => request.headers.authorization === `Bearer ${TOKEN}`;

/**
 * The control room routes; answers false when the request is for something else. `allow(request, response)` checks
 * the caller and answers the refusal itself when it returns false (dev/mock-api.mjs passes its own guard).
 */
export function controlRoomRoutes(request, response, { allow } = {}) {
  const url = new URL(request.url ?? "/", "http://mock.local");
  if (!url.pathname.startsWith("/api/control-room/")) return false;
  if (allow) {
    if (!allow(request, response)) return true;
  } else if (!signedIn(request)) {
    json(response, 401, { error: { code: "UNAUTHENTICATED", message: "Silakan masuk terlebih dahulu." } });
    return true;
  }
  if (url.pathname === "/api/control-room/state") {
    json(response, 200, buildState());
    return true;
  }
  if (url.pathname === "/api/control-room/plan.svg") {
    response.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "private, no-cache" });
    response.end(plan.svg);
    return true;
  }
  if (url.pathname === "/api/control-room/plan-image") {
    if (!plan.image) {
      json(response, 404, { error: { code: "NOT_FOUND", message: "Gambar denah tidak ditemukan." } });
      return true;
    }
    response.writeHead(200, { "content-type": plan.image.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=300", etag: `"${planImage.version}"` });
    response.end(plan.image.bytes);
    return true;
  }
  const trip = /^\/api\/control-room\/trips\/(\d+)$/.exec(url.pathname);
  if (trip) {
    const found = timeline(Number(trip[1]));
    if (found) json(response, 200, found);
    else json(response, 404, { error: { code: "NOT_FOUND", message: "Trip tidak ditemukan." } });
    return true;
  }
  if (url.pathname === "/api/control-room/stream") {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" });
    response.write(": connected\n\n");
    if (!lastFrame) publish();
    const send = (frame) => response.write(frame);
    send(lastFrame.frame);
    listeners.add(send);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      listeners.delete(send);
      clearInterval(heartbeat);
    });
    return true;
  }
  json(response, 404, { error: { code: "NOT_FOUND", message: "Alamat tidak ditemukan." } });
  return true;
}

function handle(request, response) {
  cors(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://mock.local");
  if (request.method === "POST" && url.pathname === "/api/auth/refresh") return json(response, 200, { accessToken: TOKEN, user: USER });
  if (request.method === "POST" && url.pathname === "/api/auth/logout") return json(response, 204);
  if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { status: "ok" });
  if (request.method === "GET" && url.pathname === "/api/me") {
    if (!signedIn(request)) return json(response, 401, { error: { code: "UNAUTHENTICATED", message: "Silakan masuk terlebih dahulu." } });
    return json(response, 200, { user: USER });
  }
  if (request.method === "POST" && url.pathname === "/__mock/tick") {
    tick();
    return json(response, 200, { trucks: trucks.length });
  }
  if (controlRoomRoutes(request, response)) return;
  json(response, 404, { error: { code: "NOT_FOUND", message: "Alamat tidak ditemukan." } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setUpDay();
  publish();
  if (TICK_MS > 0) setInterval(tick, TICK_MS);
  createServer(handle).listen(PORT, HOST, () => {
    console.log(`control room mock on http://${HOST}:${PORT} (plan: ${PLAN_MODE}${plan.image ? ", with picture" : ""}, ${trucks.length} trucks inside)`);
  });
} else {
  setUpDay();
}
