// A stand-in for the API, for the web build, the smoke test and the screenshots. No dependencies, made-up data.
// Shapes follow src/api/types.ts. It also serves the web export (dist/) with a fallback to index.html.
//
//   node dev/mock-api.mjs            port 3210, or MOCK_PORT
//   POST /__mock/network {"online":false}   every /api call is cut off (the socket is destroyed), as without signal
//   POST /__mock/reset                     data back to the start
//   GET  /__mock/state                     stored form submissions and decisions, for checks
//
// Sign in with operator / contoh123 (every field module and both decision modules) or pemantau / contoh123
// (view only). operator has 23 notifications in the inbox, 4 of them unread; /__mock/state lists the unread ids
// and the registered devices.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const PORT = Number(process.env.MOCK_PORT ?? 3210);

const MINUTE = 60_000;
const ago = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();
const token = () => randomBytes(18).toString("hex");

// --- data ------------------------------------------------------------------------------------------------

const USERS = [
  {
    id: 1,
    kind: "INTERNAL",
    username: "operator",
    fullName: "Operator Contoh",
    password: "contoh123",
    permissions: { security_check: "CREATE", qc: "CREATE", unloading: "CREATE", loading: "CREATE", sealing: "CREATE", approvals: "EDIT", qc_approvals: "EDIT" },
    partner: null,
  },
  {
    id: 2,
    kind: "INTERNAL",
    username: "pemantau",
    fullName: "Pemantau Contoh",
    password: "contoh123",
    permissions: { qc: "VIEW", loading: "VIEW" },
    partner: null,
  },
];

const PARTNER_IN = { id: 11, name: "Pemasok Contoh" };
const PARTNER_OUT = { id: 12, name: "Pelanggan Contoh" };
const TRANSPORTER = { id: 21, name: "Transporter Contoh" };
const CPO = { id: 31, name: "Minyak Contoh" };
const OLEIN = { id: 32, name: "Olein Contoh" };

const PARAMETERS = {
  FFA: { code: "FFA", name: "FFA", unit: "%", decimals: 2, minValid: 0, maxValid: 20 },
  MOISTURE: { code: "MOISTURE", name: "Moisture (kadar air)", unit: "%", decimals: 3, minValid: 0, maxValid: 5 },
  IMPURITIES: { code: "IMPURITIES", name: "Impurities (kotoran)", unit: "%", decimals: 3, minValid: 0, maxValid: 5 },
  MNI: { code: "MNI", name: "M dan I", unit: "%", decimals: 3, minValid: 0, maxValid: 5 },
  IV: { code: "IV", name: "IV", unit: "", decimals: 2, minValid: 0, maxValid: 200 },
  LOVIBOND: { code: "LOVIBOND", name: "Lovibond Color", unit: "", decimals: 1, minValid: 0, maxValid: 50 },
  MELTING_POINT: { code: "MELTING_POINT", name: "Melting Point", unit: "°C", decimals: 1, minValid: 0, maxValid: 80 },
  CLOUD_POINT: { code: "CLOUD_POINT", name: "Cloud Point", unit: "°C", decimals: 1, minValid: 0, maxValid: 60 },
  SAPONIFIABLE: { code: "SAPONIFIABLE", name: "Saponifiable Matter", unit: "%", decimals: 2, minValid: 0, maxValid: 100 },
  PEROXIDE: { code: "PEROXIDE", name: "Peroxide Value", unit: "meq/kg", decimals: 2, minValid: 0, maxValid: 50 },
  SMOKE_POINT: { code: "SMOKE_POINT", name: "Smoke Point", unit: "°C", decimals: 0, minValid: 0, maxValid: 300 },
};
/** Switched on, as on the real API today (quality_parameters.is_active); the others are neither sent nor accepted. */
const ACTIVE = ["FFA", "MOISTURE", "IMPURITIES"];

const formParameters = (step) => {
  if (step.stepCode === "QC" && step.truck.flowCode === "IN_CPO") {
    return [
      { ...PARAMETERS.FFA, required: true, spec: { min: null, max: 5 } },
      { ...PARAMETERS.MOISTURE, required: true, spec: { min: null, max: 0.25 } },
      { ...PARAMETERS.IMPURITIES, required: false, spec: null },
    ];
  }
  if (step.stepCode === "QC_LOADING") {
    return ["FFA", "MOISTURE", "IMPURITIES", "MNI", "IV", "LOVIBOND", "MELTING_POINT", "CLOUD_POINT", "SAPONIFIABLE", "PEROXIDE", "SMOKE_POINT"]
      .filter((code) => ACTIVE.includes(code))
      .map((code) => ({
        ...PARAMETERS[code],
        required: code === "FFA",
        spec: code === "FFA" ? { min: null, max: 0.1 } : null,
      }));
  }
  return [];
};

// shaped like apps/api/src/work/view.ts (tankChoices): `label` says what the tank holds, tanks of the truck's
// product first; an incoming truck only gets the tanks of its product
const TANKS = [
  { id: 1, code: "T-01", name: "Tangki 1", label: "CPO", productId: CPO.id },
  { id: 2, code: "T-02", name: "Tangki 2", label: "CPO", productId: CPO.id },
  { id: 3, code: "T-03", name: "Tangki 3", label: "Olein", productId: OLEIN.id },
  { id: 4, code: "T-04", name: "Tangki 4", label: "Stearin", productId: null },
];
const tankChoices = (step) => {
  const judged = TANKS.flatMap(({ productId, ...tank }) => {
    const fits = productId === step.truck.product?.id;
    if (!fits && (step.truck.direction === "IN" || tank.label === "CPO")) return [];
    return [{ ...tank, fitsProduct: fits }];
  });
  return [...judged.filter((tank) => tank.fitsProduct), ...judged.filter((tank) => !tank.fitsProduct)];
};

const MODULE_OF = { SEAL_CHECK: "security_check", QC: "qc", UNLOADING: "unloading", RESEAL: "sealing", CLEANLINESS: "qc", QC_LOADING: "qc", LOADING: "loading", SEALING: "sealing" };
const STEP_NAMES = {
  SEAL_CHECK: "Cek segel",
  QC: "QC pass",
  UNLOADING: "Bongkar",
  RESEAL: "Segel kembali (reject)",
  CLEANLINESS: "Cek kebersihan dan najis",
  QC_LOADING: "QC loading",
  LOADING: "Muat",
  SEALING: "Segel (locis)",
};

function truck(n, flowCode, product) {
  const incoming = flowCode.startsWith("IN");
  return {
    tripId: 100 + n,
    tripNo: `TR-${String(n).padStart(4, "0")}`,
    plateNo: `ZZ${String(n).padStart(4, "0")}CTH`,
    plateDisplay: `ZZ ${String(n).padStart(4, "0")} CTH`,
    direction: incoming ? "IN" : "OUT",
    flowCode,
    product,
    partner: incoming ? PARTNER_IN : PARTNER_OUT,
    transporter: TRANSPORTER,
    driverName: "Supir Contoh",
  };
}

function step(id, n, stepCode, flowCode, product, minutes, extra = {}) {
  return {
    id,
    stepCode,
    name: flowCode === "OUT_PACKED" && stepCode === "LOADING" ? "Muat di loading dock" : STEP_NAMES[stepCode],
    module: MODULE_OF[stepCode],
    status: "READY",
    result: null,
    attempt: 1,
    readyAt: ago(minutes),
    startedAt: null,
    truck: truck(n, flowCode, product),
    ...extra,
  };
}

function initialState() {
  const steps = [
    step(1, 1, "SEAL_CHECK", "IN_CPO", CPO, 4),
    step(2, 2, "QC", "IN_CPO", CPO, 12),
    step(3, 3, "QC", "IN_CPO", CPO, 31, { status: "IN_PROGRESS", result: "HOLD", startedAt: ago(20) }),
    step(4, 4, "UNLOADING", "IN_CPO", CPO, 18),
    step(5, 5, "RESEAL", "IN_CPO", CPO, 9),
    step(6, 6, "CLEANLINESS", "OUT_BULK", OLEIN, 25),
    step(7, 7, "QC_LOADING", "OUT_BULK", OLEIN, 7),
    step(8, 8, "LOADING", "OUT_BULK", OLEIN, 15),
    step(9, 9, "LOADING", "OUT_PACKED", OLEIN, 40, { status: "IN_PROGRESS", startedAt: ago(22) }),
    step(10, 10, "SEALING", "OUT_BULK", OLEIN, 3, { attempt: 2 }),
    step(11, 11, "CLEANLINESS", "OUT_PACKED", OLEIN, 2),
  ];
  const seals = Array.from({ length: 30 }, (_, at) => ({ id: 500 + at, sealNo: `L-${String(101 + at).padStart(6, "0")}`, kind: at % 10 === 9 ? "CUSTOMS" : "LOCIS", status: "AVAILABLE" }));
  const exceptions = [
    exceptionRow(901, "GROSS_IN", 12, { expectedValue: 41000, actualValue: 41500, diffValue: 500, diffPct: 1.2195, tolerancePct: 0.3, liveWeightKg: 41500, stage: 1, raisedAt: ago(2) }),
    exceptionRow(902, "TARE_OUT", 13, { expectedValue: 12000, actualValue: 12240, diffValue: 240, diffPct: 2, tolerancePct: 0.15, liveWeightKg: 12240, stage: 1, raisedAt: ago(1) }),
    exceptionRow(903, "NET_OUT", 14, { expectedValue: 30000, actualValue: 29620, diffValue: -380, diffPct: -1.2667, tolerancePct: 0.5, liveWeightKg: 41860, stage: 2, raisedAt: ago(3) }),
    exceptionRow(904, "PLATE", 15, { plateRead: "ZZ0O15CTH", liveWeightKg: 39880, stage: 1, raisedAt: ago(0.5) }),
    exceptionRow(905, "QC_HOLD", 3, {
      station: null,
      approverModule: "qc_approvals",
      raisedAt: ago(20),
      context: { plateNo: "ZZ0003CTH", disposition: "HOLD", reasonCode: "FFA_OUT", values: { FFA: 5.62, MOISTURE: 0.21, IMPURITIES: 0.02 }, remark: "Sampel kedua menunggu lab" },
    }),
  ];
  return { steps, seals, exceptions, notifications: initialNotifications(), devices: new Map(), submissions: new Map(), decisions: [], files: 0, sessions: new Map(), refresh: new Map() };
}

// the inbox of operator (user 1), shaped like apps/api/src/notifications/routes.ts; newest first by id.
// exceptionStatus of a request still in state.exceptions is read from there when listed.
const NOTIFICATION_TITLES = { GROSS_IN: "Selisih bruto", TARE_OUT: "Selisih tarra", NET_OUT: "Cek netto keluar", PLATE: "Plat beda", QC_HOLD: "QC ditahan", NET_IN: "Selisih netto" };
function initialNotifications() {
  const rows = [];
  let id = 100;
  const add = (type, extra) => rows.push({ id: ++id, userId: 1, type, severity: "INFO", data: {}, exceptionId: null, exceptionStatus: null, tripId: null, readAt: null, ...extra });
  // older, already settled: enough for a second page
  for (let at = 0; at < 18; at += 1) {
    const exceptionId = 700 + at;
    const kind = ["GROSS_IN", "TARE_OUT", "NET_OUT", "PLATE"][at % 4];
    add("EXCEPTION_RAISED", { severity: "ALARM", title: NOTIFICATION_TITLES[kind], body: `Trip TR-${String(200 + at).padStart(4, "0")}`, exceptionId, exceptionStatus: at % 3 === 0 ? "REJECTED" : "APPROVED", tripId: 300 + at, createdAt: ago(60 * 24 * 3 - at * 60), readAt: ago(60 * 24 * 2) });
  }
  add("DO_SENT", { title: "Delivery order baru", body: "DO-2026-0101", data: { deliveryOrderId: 7 }, createdAt: ago(60 * 20), readAt: null });
  add("EXCEPTION_CLOSED", { title: "Permintaan selesai", body: "Trip TR-0205", exceptionId: 705, exceptionStatus: "APPROVED", tripId: 305, createdAt: ago(60 * 18), readAt: ago(60 * 17) });
  add("EXCEPTION_RAISED", { severity: "ALARM", title: NOTIFICATION_TITLES.QC_HOLD, body: "Trip TR-0003", exceptionId: 905, tripId: 103, createdAt: ago(20) });
  add("EXCEPTION_RAISED", { severity: "ALARM", title: NOTIFICATION_TITLES.NET_OUT, body: "Trip TR-0014", exceptionId: 903, tripId: 114, createdAt: ago(3) });
  add("EXCEPTION_RAISED", { severity: "ALARM", title: NOTIFICATION_TITLES.GROSS_IN, body: "Trip TR-0012", exceptionId: 901, tripId: 112, createdAt: ago(2) });
  return rows;
}

function notificationView(row) {
  const live = row.exceptionId === null ? null : state.exceptions.find((item) => item.id === row.exceptionId);
  const { userId: _userId, ...rest } = row;
  return { ...rest, data: { type: row.type, ...row.data, ...(row.exceptionId ? { exceptionId: row.exceptionId } : {}) }, exceptionStatus: live ? live.status : row.exceptionStatus };
}
const unreadOf = (user) => state.notifications.filter((row) => row.userId === user.id && row.readAt === null).length;

function exceptionRow(id, type, n, extra) {
  const plateNo = `ZZ${String(n).padStart(4, "0")}CTH`;
  return {
    id,
    type,
    status: "PENDING",
    decision: null,
    trip: { id: 100 + n, tripNo: `TR-${String(n).padStart(4, "0")}`, plateNo, plateDisplay: `ZZ ${String(n).padStart(4, "0")} CTH` },
    station: { id: 1, code: "WB-1", name: "Timbangan 1" },
    stage: null,
    expectedValue: null,
    actualValue: null,
    diffValue: null,
    diffPct: null,
    tolerancePct: null,
    liveWeightKg: null,
    liveWeightAt: new Date().toISOString(),
    plateRead: plateNo,
    plateNo,
    approverModule: "approvals",
    raisedAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    reason: null,
    reportNo: null,
    weighingId: null,
    context: {},
    ...extra,
  };
}

let state = initialState();
let online = true;

// --- http helpers ----------------------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...CORS });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
const fail = (res, status, code, message, fields) => send(res, status, { error: { code, message, ...(fields ? { fields } : {}) } });

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function accountOf(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  const userId = match ? state.sessions.get(match[1]) : undefined;
  return USERS.find((user) => user.id === userId) ?? null;
}
const publicUser = ({ password: _password, ...user }) => user;

function issue(userId) {
  const access = token();
  const refresh = token();
  state.sessions.set(access, userId);
  state.refresh.set(refresh, userId);
  return { accessToken: access, refreshToken: refresh };
}

const can = (user, module, level) => {
  const rank = { VIEW: 1, CREATE: 2, EDIT: 3 };
  const held = user.permissions[module];
  return held !== undefined && rank[held] >= rank[level];
};
const viewable = (user) => Object.keys(user.permissions);

const lettersAndDigits = (text) => String(text ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function formData(step) {
  const incoming = step.truck.direction === "IN";
  return {
    letter: incoming ? { docGrossKg: 40000 + step.id * 10, docTareKg: 12000, docNetKg: 28000 + step.id * 10, allocations: [] } : null,
    declaredSeals:
      step.stepCode === "SEAL_CHECK"
        ? [
            { id: 71, sealNo: "SG-200101", kind: "LOCIS" },
            { id: 72, sealNo: "SG-200102", kind: "LOCIS" },
          ]
        : [],
    tanks: ["UNLOADING", "QC_LOADING"].includes(step.stepCode) ? tankChoices(step) : [],
    parameters: formParameters(step),
    sealsInPlace:
      step.stepCode === "SEALING" && step.attempt > 1 ? [{ id: 81, sealId: 480, sealNo: "L-000080", kind: "LOCIS", position: null, appliedAt: ago(50) }] : [],
    history: [],
  };
}

// --- forms -----------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORM_STEPS = {
  "seal-check": ["SEAL_CHECK"],
  "qc-receiving": ["QC"],
  reseal: ["RESEAL"],
  unloading: ["UNLOADING"],
  cleanliness: ["CLEANLINESS"],
  "qc-loading": ["QC_LOADING"],
  "loading/start": ["LOADING"],
  "loading/finish": ["LOADING"],
  sealing: ["SEALING"],
};

function plausibility(values) {
  const fields = [];
  for (const [code, value] of Object.entries(values ?? {})) {
    const parameter = PARAMETERS[code];
    if (!parameter) fields.push({ field: `values.${code}`, message: `Parameter ${code} tidak dikenal.` });
    else if (!ACTIVE.includes(code)) fields.push({ field: `values.${code}`, message: `${parameter.name} belum dipakai.` });
    else if (typeof value !== "number" || value < parameter.minValid || value > parameter.maxValid) {
      fields.push({ field: `values.${code}`, message: `${parameter.name} harus antara ${parameter.minValid} dan ${parameter.maxValid}.` });
    }
  }
  return fields;
}

function runForm(res, user, stepId, form, body) {
  if (!body || typeof body.clientUuid !== "string" || !UUID.test(body.clientUuid)) {
    return fail(res, 400, "VALIDATION", "Data yang dikirim tidak valid.", [{ field: "clientUuid", message: "Nomor kiriman (clientUuid) harus berupa UUID." }]);
  }
  const stored = state.submissions.get(body.clientUuid);
  if (stored) {
    stored.posts += 1;
    if (stored.stepId !== stepId || stored.form !== form) return fail(res, 409, "UUID_REUSED", "Nomor kiriman ini sudah dipakai untuk form lain.");
    return send(res, 200, stored.response);
  }
  const row = state.steps.find((item) => item.id === stepId);
  if (!row) return fail(res, 404, "NOT_FOUND", "Langkah tidak ditemukan.");
  if (!can(user, row.module, "CREATE")) return fail(res, 403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
  if (!FORM_STEPS[form]?.includes(row.stepCode)) return fail(res, 409, "WRONG_STEP", `Form ini bukan untuk langkah ${row.name}.`);
  const ready = form === "loading/finish" ? row.status === "IN_PROGRESS" : row.status === "READY";
  if (!ready) return fail(res, 409, "NOT_READY", row.result === "HOLD" ? "Langkah ini menunggu keputusan QC." : "Langkah ini belum siap atau sudah selesai.");
  const problems = plausibility(body.values);
  if (problems.length) return fail(res, 400, "VALIDATION", "Data yang dikirim tidak valid.", problems);
  for (const seal of body.seals ?? []) {
    if (seal.sealId === undefined) continue;
    const stock = state.seals.find((item) => item.id === seal.sealId);
    if (!stock) return fail(res, 400, "VALIDATION", "Data yang dikirim tidak valid.", [{ field: "seals", message: "Segel tidak ditemukan." }]);
    if (stock.status !== "AVAILABLE") return fail(res, 409, "SEAL_NOT_AVAILABLE", `Segel ${stock.sealNo} sudah terpakai atau dibatalkan.`);
  }
  for (const seal of body.seals ?? []) {
    const stock = state.seals.find((item) => item.id === seal.sealId);
    if (stock) stock.status = "USED";
  }

  let status = "DONE";
  if (form === "loading/start") {
    row.status = "IN_PROGRESS";
    row.startedAt = body.startedAt ?? new Date().toISOString();
    status = "IN_PROGRESS";
  } else {
    state.steps = state.steps.filter((item) => item.id !== stepId);
  }
  const response = {
    step: { id: row.id, stepCode: row.stepCode, name: row.name, status, result: status === "DONE" ? "PASS" : null, attempt: row.attempt },
    trip: { id: row.truck.tripId, tripNo: row.truck.tripNo, plateNo: row.truck.plateNo },
    next: null,
  };
  state.submissions.set(body.clientUuid, { stepId, form, body, response, posts: 1, at: new Date().toISOString() });
  return send(res, 200, response);
}

// --- decisions -------------------------------------------------------------------------------------------

function moveLiveWeight(row) {
  if (row.status !== "PENDING" || row.liveWeightKg === null) return;
  const wobble = Math.round((Math.random() - 0.5) * 40);
  row.liveWeightKg += wobble;
  row.liveWeightAt = new Date().toISOString();
  if (row.actualValue !== null && row.type !== "NET_OUT") {
    row.actualValue = row.liveWeightKg;
    row.diffValue = row.actualValue - row.expectedValue;
    row.diffPct = (row.diffValue / row.expectedValue) * 100;
  }
}

function decide(res, user, row, body) {
  const netOut = row.type === "NET_OUT";
  const allowed = netOut ? ["OK", "ADD_LOAD", "REDUCE_LOAD"] : ["APPROVE", "REJECT"];
  const fields = [];
  if (!allowed.includes(body?.decision)) fields.push({ field: "decision", message: netOut ? "Keputusan harus OK, ADD_LOAD, atau REDUCE_LOAD." : "Keputusan harus APPROVE atau REJECT." });
  if (["GROSS_IN", "TARE_OUT", "NET_IN"].includes(row.type) && String(body?.reason ?? "").trim().length < 3) fields.push({ field: "reason", message: "Alasan wajib diisi, minimal 3 huruf." });
  if (body?.updateMasterTare && !(row.type === "TARE_OUT" && body.decision === "APPROVE")) {
    fields.push({ field: "updateMasterTare", message: "Tarra master hanya bisa diganti pada selisih tarra yang disetujui." });
  }
  if (fields.length) return fail(res, 400, "VALIDATION", "Data yang dikirim tidak valid.", fields);
  if (row.status === "CANCELLED") return fail(res, 409, "EXCEPTION_CANCELLED", "Permintaan ini sudah dibatalkan.");
  if (row.status !== "PENDING") return fail(res, 409, "ALREADY_DECIDED", "Permintaan ini sudah diputuskan.");
  if (!can(user, row.approverModule, "EDIT")) return fail(res, 403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
  row.status = body.decision === "REJECT" ? "REJECTED" : body.decision === "ADD_LOAD" || body.decision === "REDUCE_LOAD" ? "RETRY" : "APPROVED";
  row.decision = body.decision;
  row.decidedAt = new Date().toISOString();
  row.decidedBy = { id: user.id, fullName: user.fullName };
  row.reason = body.reason ?? null;
  if (row.status === "APPROVED" && ["GROSS_IN", "TARE_OUT", "NET_IN"].includes(row.type)) row.reportNo = `BA-${row.id}/CONTOH`;
  state.decisions.push({ id: row.id, ...body });
  return send(res, 200, { exception: row, weighing: null, next: null });
}

// --- routes ----------------------------------------------------------------------------------------------

async function api(req, res, url) {
  const { pathname } = url;
  if (req.method === "OPTIONS") return send(res, 204);

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    const user = USERS.find((item) => item.username === String(body?.username ?? "").toLowerCase());
    if (!body?.username || !body?.password) return fail(res, 400, "VALIDATION", "Data yang dikirim tidak valid.", [{ field: "username", message: "Username wajib diisi." }]);
    if (!user || user.password !== body.password) return fail(res, 401, "INVALID_CREDENTIALS", "Username atau password salah.");
    return send(res, 200, { ...issue(user.id), user: publicUser(user) });
  }
  if (pathname === "/api/auth/refresh" && req.method === "POST") {
    const body = await readJson(req);
    const userId = state.refresh.get(body?.refreshToken);
    if (userId === undefined) return fail(res, 401, "INVALID_SESSION", "Sesi sudah berakhir. Silakan masuk lagi.");
    state.refresh.delete(body.refreshToken);
    return send(res, 200, issue(userId));
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const body = await readJson(req);
    state.refresh.delete(body?.refreshToken);
    return send(res, 200, { ok: true });
  }

  const user = accountOf(req);
  if (!user) return fail(res, 401, "UNAUTHORIZED", "Silakan masuk dulu.");

  if (pathname === "/api/me") return send(res, 200, { user: publicUser(user) });

  if (pathname === "/api/work/steps" && req.method === "GET") {
    const modules = viewable(user).filter((code) => !url.searchParams.get("module") || code === url.searchParams.get("module"));
    const q = lettersAndDigits(url.searchParams.get("q"));
    const items = state.steps
      .filter((row) => modules.includes(row.module) && (!q || row.truck.plateNo.includes(q)))
      .sort((a, b) => a.readyAt.localeCompare(b.readyAt));
    return send(res, 200, { items });
  }
  const detail = /^\/api\/work\/steps\/(\d+)$/.exec(pathname);
  if (detail && req.method === "GET") {
    const row = state.steps.find((item) => item.id === Number(detail[1]));
    if (!row || !viewable(user).includes(row.module)) return fail(res, 404, "NOT_FOUND", "Langkah tidak ditemukan.");
    return send(res, 200, { step: row, form: formData(row) });
  }
  const form = /^\/api\/work\/steps\/(\d+)\/([a-z-]+(?:\/(?:start|finish))?)$/.exec(pathname);
  if (form && req.method === "POST") return runForm(res, user, Number(form[1]), form[2], await readJson(req));

  if (pathname === "/api/work/find") {
    const plate = lettersAndDigits(url.searchParams.get("plate"));
    const barcode = String(url.searchParams.get("barcode") ?? "").toUpperCase();
    const n = barcode.startsWith("SPJ-") ? Number(barcode.slice(4)) : null;
    const match = state.steps.find((row) => (plate && row.truck.plateNo === plate) || (n !== null && row.truck.tripId === 100 + n));
    if (!match) return fail(res, 404, "NOT_FOUND", "Truk di dalam pabrik tidak ditemukan.");
    const steps = state.steps.filter((row) => row.truck.tripId === match.truck.tripId && viewable(user).includes(row.module)).map(({ truck: _truck, ...rest }) => rest);
    return send(res, 200, { truck: match.truck, steps });
  }
  if (pathname === "/api/work/seals/available") {
    if (!can(user, "sealing", "CREATE")) return fail(res, 403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
    const q = String(url.searchParams.get("q") ?? "").toUpperCase();
    const items = state.seals.filter((seal) => seal.status === "AVAILABLE" && (!q || seal.sealNo.includes(q))).map(({ status: _status, ...seal }) => seal);
    return send(res, 200, { items });
  }
  if (pathname === "/api/files" && req.method === "POST") {
    const raw = await readRaw(req);
    if (!String(req.headers["content-type"] ?? "").startsWith("multipart/form-data") || raw.length === 0) {
      return fail(res, 400, "VALIDATION", "Data yang dikirim tidak valid.", [{ field: "file", message: "Kirim satu gambar sebagai multipart/form-data." }]);
    }
    if (raw.length > 5 * 1024 * 1024) return fail(res, 413, "FILE_TOO_LARGE", "Berkas paling besar 5 MB.");
    state.files += 1;
    return send(res, 201, { id: 7000 + state.files });
  }

  // --- devices and inbox (apps/api/src/notifications/routes.ts) ---
  if (pathname === "/api/devices" && req.method === "POST") {
    const body = await readJson(req);
    const platform = body?.platform;
    const pushToken = typeof body?.pushToken === "string" ? body.pushToken.trim() : "";
    const fields = [];
    if (!["ANDROID", "IOS", "WEB"].includes(platform)) fields.push({ field: "platform", message: "Platform harus ANDROID, IOS, atau WEB." });
    if (!pushToken) fields.push({ field: "pushToken", message: "Token perangkat wajib diisi." });
    if (fields.length) return fail(res, 400, "VALIDATION", "Data yang dikirim tidak valid.", fields);
    const known = state.devices.get(pushToken);
    const device = { id: known?.id ?? state.devices.size + 1, userId: user.id, platform, appVersion: body.appVersion ?? null, isActive: true, lastSeenAt: new Date().toISOString() };
    state.devices.set(pushToken, device);
    const { userId: _userId, ...view } = device;
    return send(res, 200, { device: view });
  }
  const deviceToken = /^\/api\/devices\/(.+)$/.exec(pathname);
  if (deviceToken && req.method === "DELETE") {
    const device = state.devices.get(decodeURIComponent(deviceToken[1]));
    if (!device || device.userId !== user.id) return fail(res, 404, "NOT_FOUND", "Perangkat tidak ditemukan.");
    device.isActive = false;
    device.lastSeenAt = new Date().toISOString();
    return send(res, 204);
  }
  if (pathname === "/api/notifications" && req.method === "GET") {
    const unread = ["true", "1"].includes(url.searchParams.get("unread") ?? "");
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
    const before = url.searchParams.get("before") ? Number(url.searchParams.get("before")) : null;
    const items = state.notifications
      .filter((row) => row.userId === user.id && (!unread || row.readAt === null) && (before === null || row.id < before))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(notificationView);
    return send(res, 200, { items, unreadCount: unreadOf(user) });
  }
  if (pathname === "/api/notifications/read-all" && req.method === "POST") {
    const now = new Date().toISOString();
    let updated = 0;
    for (const row of state.notifications) {
      if (row.userId === user.id && row.readAt === null) {
        row.readAt = now;
        updated += 1;
      }
    }
    return send(res, 200, { updated, unreadCount: 0 });
  }
  const readOne = /^\/api\/notifications\/(\d+)\/read$/.exec(pathname);
  if (readOne && req.method === "POST") {
    const row = state.notifications.find((item) => item.id === Number(readOne[1]) && item.userId === user.id);
    if (!row) return fail(res, 404, "NOT_FOUND", "Pemberitahuan tidak ditemukan.");
    row.readAt ??= new Date().toISOString();
    return send(res, 200, { notification: notificationView(row), unreadCount: unreadOf(user) });
  }

  if (pathname === "/api/exceptions" && req.method === "GET") {
    if (!can(user, "approvals", "VIEW") && !can(user, "qc_approvals", "VIEW")) return fail(res, 403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
    const statuses = (url.searchParams.get("status") ?? "").split(",").filter(Boolean);
    state.exceptions.forEach(moveLiveWeight);
    return send(res, 200, { items: state.exceptions.filter((row) => !statuses.length || statuses.includes(row.status)) });
  }
  const one = /^\/api\/exceptions\/(\d+)(\/decide)?$/.exec(pathname);
  if (one) {
    const row = state.exceptions.find((item) => item.id === Number(one[1]));
    if (!row) return fail(res, 404, "NOT_FOUND", "Permintaan tidak ditemukan.");
    if (one[2] && req.method === "POST") return decide(res, user, row, await readJson(req));
    moveLiveWeight(row);
    return send(res, 200, { exception: row });
  }
  return fail(res, 404, "NOT_FOUND", "Alamat tidak ditemukan.");
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

async function staticFile(res, pathname) {
  if (!existsSync(DIST)) return fail(res, 404, "NO_BUILD", "Run `npx expo export --platform web` first.");
  const wanted = path.resolve(DIST, `.${decodeURIComponent(pathname)}`);
  const inside = wanted.startsWith(DIST);
  const file = inside && existsSync(wanted) && path.extname(wanted) ? wanted : path.join(DIST, "index.html");
  const bytes = await readFile(file);
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(bytes);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/__mock/network" && req.method === "POST") {
      const body = await readJson(req);
      online = body?.online !== false;
      return send(res, 200, { online });
    }
    if (url.pathname === "/__mock/reset" && req.method === "POST") {
      state = initialState();
      online = true;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__mock/state") {
      return send(res, 200, {
        online,
        submissions: [...state.submissions.entries()].map(([clientUuid, item]) => ({ clientUuid, stepId: item.stepId, form: item.form, posts: item.posts, body: item.body })),
        decisions: state.decisions,
        files: state.files,
        devices: [...state.devices.entries()].map(([pushToken, device]) => ({ pushToken, ...device })),
        unread: state.notifications.filter((row) => row.readAt === null).map((row) => row.id),
      });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!online) {
        // no signal: the request never gets an answer
        req.socket.destroy();
        return;
      }
      return await api(req, res, url);
    }
    return await staticFile(res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) fail(res, 500, "INTERNAL", "Terjadi kesalahan di server.");
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock API on http://127.0.0.1:${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
