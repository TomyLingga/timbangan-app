// Mock of the registration API for front-end work. Node only, no dependencies.
//
//   node dev/mock-api.mjs
//
// Every name, company and contract below is made up. Nothing here talks to a
// real system. State lives in memory and is gone when the process stops.
//
// Environment:
//   PORT           port to listen on (default 3100)
//   HOST           interface to bind (default localhost)
//   WEB_ORIGIN     origin of the web app, for CORS and the SSO redirect (default http://localhost:3000)
//   ACCESS_TTL_S   lifetime of an access token in seconds (default 900)
//   MOCK_ODOO      "off" makes the sync answer 503 NOT_CONFIGURED
//   MOCK_SSO       "off" makes the SSO exchange answer 503 NOT_CONFIGURED
//   MOCK_VCF       "off" makes the driver registry sync answer 503, "fail" makes it answer 502
//   MOCK_SYNC_MS   how long a sync takes (default 1200)
//
// Access follows docs/rancangan-hak-akses.md: every account holds a level per
// module (VIEW, CREATE, EDIT), and each route checks the module and level that
// apps/api/test/route-permissions.test.ts lists for it. Phase 3 routes, codes
// and answers follow apps/api (docs/fase-3-penyelarasan.md).
//
// Helpers that the real API does not have (used by dev/smoke.mjs):
//   GET  /api/auth/sso/start?as=<username>&to=root|callback   plays the portal: redirects back with a ticket
//   POST /__mock/expire-access-tokens                         makes every access token invalid
//   POST /__mock/end-sessions                                 also drops every refresh session
//   GET  /__mock/stats                                        request counts per route

import { randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? "localhost";
const WEB_ORIGIN = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
const ACCESS_TTL_MS = Number(process.env.ACCESS_TTL_S ?? 900) * 1000;
const ODOO_CONFIGURED = process.env.MOCK_ODOO !== "off";
const SSO_CONFIGURED = process.env.MOCK_SSO !== "off";
const SYNC_MS = Number(process.env.MOCK_SYNC_MS ?? 1200);

const REFRESH_COOKIE = "mock_refresh";
const APP_ID = "mock-app";
const TICKET_TTL_MS = 5 * 60 * 1000;
const VCF_MODE = process.env.MOCK_VCF ?? "on";

// --- made-up data -----------------------------------------------------------

const partners = {
  pksA: { id: "p-101", name: "PKS Contoh A" },
  pksB: { id: "p-102", name: "PKS Contoh B" },
  pksC: { id: "p-103", name: "PKS Contoh C" },
  customerA: { id: "p-201", name: "Customer Contoh A" },
  customerB: { id: "p-202", name: "Customer Contoh B" },
  transporterA: { id: "p-301", name: "Transporter Contoh A" },
};

const products = {
  cpo: { id: "g-1", name: "CPO", category: "CPO" },
  kernel: { id: "g-2", name: "Palm Kernel", category: "INCOMING_NON_CPO" },
  olein: { id: "g-3", name: "RBD Palm Olein", category: "OUTGOING_LIQUID" },
  stearin: { id: "g-4", name: "RBD Palm Stearin", category: "OUTGOING_LIQUID" },
  pfad: { id: "g-5", name: "PFAD", category: "OUTGOING_LIQUID" },
};

partners.transporterB = { id: "p-302", name: "Transporter Contoh B" };
partners.customerC = { id: "p-203", name: "Customer Contoh C" };

/** The id prefix says what a made-up partner is: p-1 supplier, p-2 customer, p-3 transporter. */
const partnerRole = (partner) => ({ 1: "supplier", 2: "customer", 3: "transporter" })[partner.id[2]];

/** The company of a partner account as GET /api/me shows it, with its kinds. */
const accountPartner = (partner) =>
  partner
    ? {
        id: partner.id,
        name: partner.name,
        isSupplier: partnerRole(partner) === "supplier",
        isTransporter: partnerRole(partner) === "transporter",
        isCustomer: partnerRole(partner) === "customer",
      }
    : null;

// The active modules of migration 0004 in apps/api, with the levels each has.
const modules = [
  ["contracts", "Kontrak", ["VIEW", "EDIT"], true],
  ["drivers", "Supir", ["VIEW", "CREATE", "EDIT"], true],
  ["vehicles", "Kendaraan", ["VIEW", "CREATE", "EDIT"], true],
  ["destinations", "Tujuan", ["VIEW", "CREATE", "EDIT"], false],
  ["delivery_orders", "Delivery Order", ["VIEW", "CREATE", "EDIT"], true],
  ["registrations", "Registrasi", ["VIEW", "CREATE", "EDIT"], true],
  ["gate", "Pos registrasi", ["VIEW", "CREATE", "EDIT"], false],
  ["rfid_cards", "Kartu RFID", ["VIEW", "CREATE", "EDIT"], false],
  ["users", "Pengguna dan hak akses", ["VIEW", "EDIT"], false],
].map(([code, name, levels, partnerAllowed]) => ({ code, name, levels, partnerAllowed }));

const everything = () => Object.fromEntries(modules.map((item) => [item.code, item.levels.at(-1)]));
const allBut = (...codes) => Object.fromEntries(Object.entries(everything()).filter(([code]) => !codes.includes(code)));

// Staff accounts sign in through the portal; `petugas.lokal` stands for the
// emergency local account (npm run user:create -- --admin) and signs in with a
// password. The passwords are fixtures for this mock, not credentials of anything.
const users = [
  { id: "u-1", kind: "INTERNAL", username: "admin.contoh", fullName: "Admin Contoh", permissions: allBut("users"), partner: null },
  {
    id: "u-2",
    kind: "INTERNAL",
    username: "pos.contoh",
    fullName: "Petugas Pos Contoh",
    permissions: { contracts: "VIEW", drivers: "CREATE", vehicles: "CREATE", destinations: "VIEW", registrations: "CREATE", gate: "EDIT" },
    partner: null,
  },
  { id: "u-3", kind: "INTERNAL", username: "staf.baru", fullName: "Staf Baru Contoh", permissions: {}, partner: null },
  // partner defaults of rancangan-hak-akses.md section 3
  {
    id: "u-4",
    kind: "PARTNER",
    username: "pks.contoh.a",
    fullName: "Admin PKS Contoh A",
    permissions: { contracts: "VIEW", registrations: "CREATE", vehicles: "CREATE", drivers: "CREATE" },
    partner: partners.pksA,
    password: "contoh-123",
  },
  {
    id: "u-5",
    kind: "PARTNER",
    username: "transporter.contoh",
    fullName: "Admin Transporter Contoh A",
    permissions: { delivery_orders: "EDIT", registrations: "CREATE", vehicles: "CREATE", drivers: "CREATE" },
    partner: partners.transporterA,
    password: "contoh-123",
  },
  { id: "u-6", kind: "INTERNAL", username: "super.contoh", fullName: "Admin Sistem Contoh", permissions: everything(), partner: null },
  { id: "u-7", kind: "INTERNAL", username: "petugas.lokal", fullName: "Petugas Lokal Contoh", permissions: everything(), partner: null, password: "contoh-123" },
];
users.forEach((user, index) => {
  user.employeeNo = user.kind === "INTERNAL" ? `EMP-CONTOH-${String(index + 1).padStart(2, "0")}` : null;
  user.isActive = true;
  user.lastLoginAt = null;
});

/** A date some days from today, so "expired" rows stay expired whenever the mock runs. */
const daysFromNow = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const today = () => daysFromNow(0);

let nextDriverId = 1;
function driver(fullName, licenceNo, licenceClass, validInDays, registryStatus, extra = {}) {
  return {
    id: `d-${nextDriverId++}`,
    fullName,
    licenceNo,
    licenceClass,
    licenceValidUntil: daysFromNow(validInDays),
    phone: null,
    registryStatus,
    registrySyncedAt: registryStatus === "UNKNOWN" ? null : new Date().toISOString(),
    // NONE: nothing to send. PENDING: entered here, waiting to go to the registry. FAILED: the registry refused it.
    registryPush: "NONE",
    registryPushError: null,
    isActive: true,
    ...extra,
  };
}

const drivers = [
  driver("Supir Contoh 01", "CONTOH0001", "B2 UMUM", 400, "NORMAL"),
  driver("Supir Contoh 02", "CONTOH0002", "B2 UMUM", 200, "NORMAL"),
  driver("Supir Contoh 03", "CONTOH0003", "B1 UMUM", 90, "WARNING"),
  driver("Supir Contoh 04", "CONTOH0004", "B2 UMUM", 300, "BLACKLIST"),
  driver("Supir Contoh 05", "CONTOH0005", "B2", -30, "NORMAL"),
  driver("Supir Contoh 06", "CONTOH0006", "B1", 500, "UNKNOWN"),
  driver("Supir Contoh 07", "CONTOH0007", "B2 UMUM", 150, "NORMAL", { isActive: false }),
  driver("Supir Contoh 08", "CONTOH0008", "B2 UMUM", -5, "WARNING"),
  driver("Supir Contoh 09", "CONTOH0009", "B2 UMUM", 250, "UNKNOWN", { registryPush: "PENDING" }),
  // `rejectsPush` is mock-only: the registry keeps refusing this driver, so it stays FAILED after a sync.
  driver("Supir Contoh 10", "CONTOH0010", "B1 UMUM", 180, "UNKNOWN", {
    registryPush: "FAILED",
    registryPushError: "Registry refused the record: licence class not accepted (mock)",
    rejectsPush: true,
  }),
];

const vehicleTypes = [
  { code: "TANGKI", name: "Truk tangki", isTank: true, needsContainerNo: false },
  { code: "BAK", name: "Truk bak", isTank: false, needsContainerNo: false },
  { code: "KONTAINER", name: "Truk kontainer", isTank: false, needsContainerNo: true },
];

const plateKey = (plate) => String(plate ?? "").replace(/\s+/g, "").toUpperCase();

let nextVehicleId = 1;
function vehicle(plateDisplay, vehicleTypeCode, owner, extra = {}) {
  return {
    id: `v-${nextVehicleId++}`,
    plateNo: plateKey(plateDisplay),
    plateDisplay,
    vehicleTypeCode,
    owner,
    ownership: owner ? "MITRA" : null,
    capacityKg: 10000,
    productionYear: 2020,
    tareKg: 5000,
    stnkValidUntil: daysFromNow(300),
    taxValidUntil: daysFromNow(200),
    kirValidUntil: daysFromNow(100),
    isActive: true,
    verified: true,
    ...extra,
  };
}

// "ZZ" is not a region code, so these plates cannot belong to a real vehicle.
const vehicles = [
  vehicle("ZZ 0001 CTH", "TANGKI", partners.transporterA),
  vehicle("ZZ 0002 CTH", "TANGKI", partners.transporterA, { capacityKg: 20000, tareKg: 9000, kirValidUntil: daysFromNow(-10) }),
  vehicle("ZZ 0003 CTH", "BAK", partners.transporterB, { productionYear: 2015 }),
  vehicle("ZZ 0004 CTH", "KONTAINER", partners.transporterB, { isActive: false, stnkValidUntil: daysFromNow(-400), taxValidUntil: daysFromNow(-400) }),
  vehicle("ZZ 0005 CTH", null, null, { capacityKg: null, productionYear: null, tareKg: null, verified: false }),
];

let nextDestinationId = 1;
function destination(partner, name, address, extra = {}) {
  return {
    id: `t-${nextDestinationId++}`,
    partner,
    name,
    address,
    district: "Kecamatan Contoh",
    regency: "Kabupaten Contoh",
    province: "Provinsi Contoh",
    isActive: true,
    ...extra,
  };
}

const destinations = [
  destination(partners.customerA, "Gudang Contoh 1", "Jalan Contoh No. 1"),
  destination(partners.customerA, "Gudang Contoh 2", "Jalan Contoh No. 2", { regency: "Kota Contoh" }),
  destination(partners.customerB, "Pabrik Contoh", "Kawasan Industri Contoh Blok A"),
  destination(partners.customerB, "Depo Contoh Lama", "Jalan Contoh No. 9", { isActive: false, district: null }),
];

let nextContractId = 1;
const startedAt = new Date().toISOString();

function contract(contractNo, direction, partner, product, qtyContract, extra = {}) {
  return {
    id: `c-${nextContractId++}`,
    contractNo,
    direction,
    partner,
    product,
    qtyContract,
    uom: "Kg",
    tolerancePct: direction === "IN" ? 0.25 : 0.2,
    certificate: null,
    validFrom: "2026-11-01",
    validUntil: "2026-12-31",
    customerPoNo: null,
    state: "OPEN",
    syncedAt: startedAt,
    ...extra,
  };
}

const contracts = [
  contract("0123/CONTOH/CPO/XI/2026", "IN", partners.pksA, products.cpo, 1000000, { certificate: "SERT-A" }),
  contract("0124/CONTOH/CPO/XI/2026", "IN", partners.pksA, products.cpo, 750000.5),
  contract("0125/CONTOH/CPO/XI/2026", "IN", partners.pksB, products.cpo, 2500000, { certificate: "SERT-B", validUntil: "2027-01-31" }),
  contract("0126/CONTOH/PK/XI/2026", "IN", partners.pksB, products.kernel, 300000, { tolerancePct: 0.5 }),
  contract("0127/CONTOH/CPO/XI/2026", "IN", partners.pksC, products.cpo, 500000, { certificate: "SERT-A" }),
  contract("0098/CONTOH/CPO/X/2026", "IN", partners.pksA, products.cpo, 1200000, { state: "CLOSED", validFrom: "2026-10-01", validUntil: "2026-10-31" }),
  contract("0101/CONTOH/CPO/X/2026", "IN", partners.pksC, products.cpo, 800000, { state: "CLOSED", validFrom: "2026-10-01", validUntil: "2026-11-15" }),
  contract("0045/CONTOH/OLEIN/XI/2026", "OUT", partners.customerA, products.olein, 2000000, { customerPoNo: "PO-CONTOH-0012", certificate: "SERT-A" }),
  contract("0046/CONTOH/OLEIN/XI/2026", "OUT", partners.customerB, products.olein, 450000, { customerPoNo: "PO-CONTOH-0044" }),
  contract("0047/CONTOH/STEARIN/XI/2026", "OUT", partners.customerA, products.stearin, 600000, { customerPoNo: "PO-CONTOH-0013" }),
  contract("0048/CONTOH/PFAD/XI/2026", "OUT", partners.customerB, products.pfad, 120000, { validUntil: "2026-11-30" }),
  contract("0031/CONTOH/OLEIN/X/2026", "OUT", partners.customerA, products.olein, 900000, { state: "CLOSED", validFrom: "2026-10-01", validUntil: "2026-10-31", customerPoNo: "PO-CONTOH-0007" }),
];

// --- in-memory state --------------------------------------------------------

const sessions = new Map(); // refresh id -> user id
const accessTokens = new Map(); // access token -> { userId, expiresAt }
const tickets = new Map(); // sso ticket -> { userId, expiresAt }
const failedLogins = new Map(); // username -> timestamps of failed attempts
const syncRuns = [];
const stats = {};
let syncRunning = false;
let vcfRunning = false;
let syncCount = 0;
let nextRunId = 1;

const newId = () => randomBytes(18).toString("base64url");

function publicUser(user) {
  const { id, kind, username, fullName, permissions } = user;
  return { id, kind, username, fullName, permissions: { ...permissions }, partner: accountPartner(user.partner) };
}

function issueAccessToken(userId) {
  const token = newId();
  accessTokens.set(token, { userId, expiresAt: Date.now() + ACCESS_TTL_MS });
  return token;
}

// --- http helpers -----------------------------------------------------------

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin || origin !== WEB_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
    vary: "Origin",
  };
}

function send(request, response, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(request),
    ...(payload ? { "content-type": "application/json; charset=utf-8" } : {}),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
  return status;
}

const fail = (request, response, status, code, message) =>
  send(request, response, status, { error: { code, message } });

/** `fields` as the API sends them: a list of { field, message }. */
const fieldList = (fields) => (Array.isArray(fields) ? fields : Object.entries(fields).map(([field, message]) => ({ field, message })));

function refreshCookie(value, maxAgeSeconds) {
  return `${REFRESH_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${maxAgeSeconds}`;
}

function readCookie(request, name) {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Returns the signed-in user, or null after answering 401. */
function authenticate(request, response) {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const entry = token ? accessTokens.get(token) : null;
  if (!entry || entry.expiresAt <= Date.now()) {
    if (token) accessTokens.delete(token);
    fail(request, response, 401, "UNAUTHENTICATED", "Missing or expired access token");
    return null;
  }
  return users.find((user) => user.id === entry.userId) ?? null;
}

const LEVEL_RANK = { VIEW: 1, CREATE: 2, EDIT: 3 };
/** Whether the account holds `level` or higher on the module: EDIT covers CREATE, CREATE covers VIEW. */
const can = (user, code, level) => {
  const held = user.permissions[code];
  return held !== undefined && LEVEL_RANK[held] >= LEVEL_RANK[level];
};

/**
 * The guards of the API, in their order: a signed-in account; on staff routes a
 * partner account is refused; a staff account without any permission gets
 * NO_ACCESS; then one of the module levels in `needs` ([code, level] pairs).
 * Returns the account, or null after answering.
 */
function guard(request, response, needs = [], { staffOnly = false } = {}) {
  const user = authenticate(request, response);
  if (!user) return null;
  if (staffOnly && user.kind !== "INTERNAL") {
    fail(request, response, 403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
    return null;
  }
  if (user.kind === "INTERNAL" && Object.keys(user.permissions).length === 0) {
    fail(request, response, 403, "NO_ACCESS", "Akun Anda belum diberi hak akses. Hubungi admin sistem.");
    return null;
  }
  if (needs.length > 0 && !needs.some(([code, level]) => can(user, code, level))) {
    fail(request, response, 403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
    return null;
  }
  return user;
}

const invalid = (request, response, fields) =>
  send(request, response, 400, { error: { code: "VALIDATION", message: "Data yang dikirim tidak valid.", fields: fieldList(fields) } });

/** Lists take `limit` (default 20, at most 50) and have no offset. */
function page(request, response, url, items) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
  return send(request, response, 200, { items: items.slice(0, limit), total: items.length });
}

const includesText = (value, q) => String(value ?? "").toLowerCase().includes(q);
const optionalText = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

function startSession(request, response, user) {
  const refreshId = newId();
  sessions.set(refreshId, user.id);
  user.lastLoginAt = new Date().toISOString();
  return send(
    request,
    response,
    200,
    { accessToken: issueAccessToken(user.id), user: publicUser(user) },
    { "set-cookie": refreshCookie(refreshId, 7 * 24 * 3600) },
  );
}

// --- shapes and checks of the master data -----------------------------------

function adminUser(user) {
  const { id, kind, username, fullName, employeeNo, permissions, isActive, lastLoginAt } = user;
  return { id, kind, username, fullName, employeeNo, partner: ref(user.partner), permissions: { ...permissions }, isActive, lastLoginAt };
}

/** Active staff accounts that can manage access (users EDIT); there must always be one. */
const adminCount = () => users.filter((user) => user.isActive && user.kind === "INTERNAL" && can(user, "users", "EDIT")).length;

function publicDriver(item) {
  // The phone number is accepted on create but is not part of the list answer.
  const rest = { ...item, licenceExpired: item.licenceValidUntil < today() };
  delete rest.phone;
  delete rest.rejectsPush;
  return rest;
}

function publicVehicle(item) {
  const documents = { STNK: item.stnkValidUntil, TAX: item.taxValidUntil, KIR: item.kirValidUntil };
  const expired = Object.keys(documents).filter((code) => documents[code] && documents[code] < today());
  return { ...item, expired };
}

const EMPTY_VEHICLE_BODY = {
  vehicleTypeCode: null,
  ownerPartnerId: null,
  ownership: null,
  capacityKg: null,
  productionYear: null,
  tareKg: null,
  stnkValidUntil: null,
  taxValidUntil: null,
  kirValidUntil: null,
};

/** Checks the body and writes it onto the vehicle. Returns an error answer, or null when saved. */
function applyVehicle(target, body, creating) {
  const fields = {};
  const next = {};
  if (creating || "plateDisplay" in body) {
    const key = plateKey(body.plateDisplay);
    if (!/^[A-Z0-9]{3,12}$/.test(key)) fields.plateDisplay = "3 to 12 letters and digits";
    next.plateNo = key;
    next.plateDisplay = String(body.plateDisplay ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  }
  if ("vehicleTypeCode" in body) {
    const known = body.vehicleTypeCode === null || vehicleTypes.some((type) => type.code === body.vehicleTypeCode);
    if (!known) fields.vehicleTypeCode = "Unknown vehicle type";
    next.vehicleTypeCode = body.vehicleTypeCode;
  }
  if ("ownerPartnerId" in body) {
    const owner = Object.values(partners).find(
      (partner) => partner.id === body.ownerPartnerId && partnerRole(partner) === "transporter",
    );
    if (body.ownerPartnerId !== null && !owner) fields.ownerPartnerId = "Unknown transporter";
    next.owner = owner ?? null;
  }
  if ("ownership" in body) {
    if (![null, "SENDIRI", "MITRA"].includes(body.ownership)) fields.ownership = "Must be SENDIRI or MITRA";
    next.ownership = body.ownership;
  }
  for (const name of ["capacityKg", "productionYear", "tareKg"]) {
    if (!(name in body)) continue;
    const value = body[name];
    if (value !== null && !(Number.isInteger(value) && value > 0)) fields[name] = "Must be a positive whole number";
    next[name] = value;
  }
  for (const name of ["stnkValidUntil", "taxValidUntil", "kirValidUntil"]) {
    if (!(name in body)) continue;
    if (body[name] !== null && !isDate(body[name])) fields[name] = "Must be a date (YYYY-MM-DD)";
    next[name] = body[name];
  }
  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") fields.isActive = "Must be true or false";
    next.isActive = body.isActive;
  }
  if (!creating && "tareKg" in next && next.tareKg !== target.tareKg && !optionalText(body.tareReason)) {
    fields.tareReason = "Required when the tare changes";
  }
  if (Object.keys(fields).length > 0) {
    return { status: 400, body: { error: { code: "VALIDATION", message: "Invalid request body", fields } } };
  }
  if (next.plateNo && vehicles.some((item) => item !== target && item.plateNo === next.plateNo)) {
    return { status: 409, body: { error: { code: "DUPLICATE", message: "A vehicle with this plate exists" } } };
  }
  Object.assign(target, next);
  return null;
}

/** Checks the body and writes it onto the destination. Returns the refused fields, or null when saved. */
function applyDestination(target, body, creating) {
  const fields = {};
  const next = {};
  for (const name of ["name", "address"]) {
    if (!creating && !(name in body)) continue;
    if (!optionalText(body[name])) fields[name] = "Required";
    else next[name] = body[name].trim();
  }
  if (creating || "partnerId" in body) {
    const partner = Object.values(partners).find(
      (candidate) => candidate.id === body.partnerId && partnerRole(candidate) === "customer",
    );
    if (body.partnerId && !partner) fields.partnerId = "Unknown customer";
    next.partner = partner ?? null;
  }
  for (const name of ["district", "regency", "province"]) {
    if (creating || name in body) next[name] = optionalText(body[name]);
  }
  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") fields.isActive = "Must be true or false";
    next.isActive = body.isActive;
  }
  if (Object.keys(fields).length > 0) return fields;
  Object.assign(target, next);
  return null;
}

// --- phase 3: settings, numbering, cards, delivery orders, registrations -----

const SITE = { code: "CTH", name: "Pabrik Contoh" };
/** Trips that no longer hold quantity (RELEASED_STATUSES in apps/api trips/view.ts). */
const DEAD_TRIP = ["CANCELLED", "EXPIRED", "REJECTED"];
/** A truck inside the plant, and one that has checked in whatever happened after. */
const INSIDE = ["CHECKED_IN", "IN_PROCESS"];
const ARRIVED = ["CHECKED_IN", "IN_PROCESS", "COMPLETED", "REJECTED"];
/** settings.driver_registry_policy as the API defaults it: BLACKLIST blocks, WARNING warns, the rest passes. */
const DRIVER_POLICY = { BLACKLIST: "BLOCK", WARNING: "WARN", UNKNOWN: "ALLOW", NORMAL: "ALLOW" };

// The mock product categories differ from the seed; this maps them the same way.
const settings = {
  spjValidDays: 7,
  flowByCategory: {
    IN: { CPO: "IN_CPO", INCOMING_NON_CPO: "IN_GOODS" },
    OUT: { OUTGOING_LIQUID: "OUT_BULK" },
  },
  maxContractsPerTrip: { IN_CPO: 2, IN_GOODS: 6, OUT_BULK: 3, OUT_PACKED: 6 },
  registrationReview: { IN_CPO: "ON_FAILED_CHECK", IN_GOODS: "ON_FAILED_CHECK", OUT_BULK: "ON_FAILED_CHECK", OUT_PACKED: "ON_FAILED_CHECK" },
};

const flowSteps = {
  IN_CPO: ["CHECK_IN", "SEAL_CHECK", "WEIGH_1", "QC", "UNLOADING", "WEIGH_2", "CHECK_OUT"],
  IN_GOODS: ["CHECK_IN", "WEIGH_1", "UNLOADING", "WEIGH_2", "CHECK_OUT"],
  OUT_BULK: ["CHECK_IN", "WEIGH_1", "LOADING", "SEAL", "WEIGH_2", "CHECK_OUT"],
};

// GET /api/quality-parameters: the active parameters with their plausible range.
const qualityParameters = [
  { code: "FFA", name: "FFA", unit: "%", decimals: 2, minValid: 0, maxValid: 20 },
  { code: "MOISTURE", name: "Moisture (kadar air)", unit: "%", decimals: 3, minValid: 0, maxValid: 5 },
  { code: "IMPURITIES", name: "Impurities (kotoran)", unit: "%", decimals: 3, minValid: 0, maxValid: 5 },
];

const TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const counters = new Map();
const nextNumber = (key) => {
  const value = (counters.get(key) ?? 0) + 1;
  counters.set(key, value);
  return value;
};

/** Year, month and day in plant time (Asia/Jakarta). */
function plantDate(date = new Date()) {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(date).split("-");
  return { year, month, day, iso: `${year}-${month}-${day}` };
}

const newToken = () => Array.from({ length: 12 }, () => TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]).join("");
const normalizeToken = (value) => String(value ?? "").toUpperCase().replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
const normalizeUid = (value) => String(value ?? "").toUpperCase().replace(/[\s:-]+/g, "");
const findPartner = (id) => Object.values(partners).find((partner) => partner.id === id) ?? null;
const ref = (partner) => (partner ? { id: partner.id, name: partner.name } : null);
const numberOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const daysAgoIso = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

// --- RFID cards

let nextCardId = 1;
const rfidCards = [
  ["04A1B2C301", "Kartu 01"],
  ["04A1B2C302", "Kartu 02"],
  ["04A1B2C303", "Kartu 03"],
  ["04A1B2C304", "Kartu 04"],
  ["04A1B2C305", "Kartu 05"],
  ["04A1B2C306", "Kartu 06", "LOST", "Hilang di area parkir (contoh)"],
  ["04A1B2C307", "Kartu 07", "RETIRED", "Retak"],
].map(([uid, label, status = "AVAILABLE", note = null]) => ({ id: `k-${nextCardId++}`, uid, label, status, note, tripId: null }));
const cardAssignments = [];

// --- delivery orders

let nextOrderId = 1;
const deliveryOrders = [];

function doNumber(date = new Date()) {
  const { year, month } = plantDate(date);
  const seq = nextNumber(`DO|${year}`);
  return `${String(seq).padStart(3, "0")}/DO/${SITE.code}/${ROMAN[Number(month) - 1]}/${year}`;
}

function seedOrder(contractNo, extra) {
  const source = contracts.find((item) => item.contractNo === contractNo);
  const order = {
    id: `do-${nextOrderId++}`,
    doNo: doNumber(),
    doDate: today(),
    status: "DRAFT",
    contractId: source.id,
    partner: source.partner,
    product: source.product,
    customerPoNo: source.customerPoNo,
    qty: 60000,
    uom: "Kg",
    tolerancePct: source.tolerancePct,
    destinationId: destinations.find((item) => item.partner?.id === source.partner.id)?.id ?? null,
    deliveryFrom: daysFromNow(-1),
    deliveryUntil: daysFromNow(14),
    transportTerms: "FRANCO",
    transporterId: null,
    truckCount: null,
    truckCountBy: null,
    remark: null,
    sentAt: null,
    acceptedAt: null,
    ...extra,
  };
  deliveryOrders.push(order);
  return order;
}

seedOrder("0045/CONTOH/OLEIN/XI/2026", { status: "SENT", transporterId: partners.transporterA.id, sentAt: daysAgoIso(1) });
seedOrder("0047/CONTOH/STEARIN/XI/2026", { qty: 30000 });
seedOrder("0046/CONTOH/OLEIN/XI/2026", {
  status: "ACCEPTED",
  qty: 20000,
  transporterId: partners.transporterB.id,
  truckCount: 2,
  truckCountBy: "ADMIN",
  sentAt: daysAgoIso(2),
  acceptedAt: daysAgoIso(1),
});

// --- registrations, trips, SPJ

let nextRegistrationId = 1;
let nextTripId = 1;
let nextSpjId = 1;
const registrations = [];
const trips = [];

const tripsOf = (registration) => trips.filter((trip) => trip.registrationId === registration.id);
const registrationOf = (trip) => registrations.find((item) => item.id === trip.registrationId);
const vehicleOf = (trip) => vehicles.find((item) => item.id === trip.vehicleId);
const driverOf = (trip) => drivers.find((item) => item.id === trip.driverId);
const nowIso = () => new Date().toISOString();

/** An issued SPJ past its date turns the trip EXPIRED when it is read. */
function refreshTrip(trip) {
  if (trip.status === "ISSUED" && trip.spj && trip.spj.validUntil < nowIso()) trip.status = "EXPIRED";
  return trip;
}

function issueSpj(trip, issuedAt = new Date()) {
  const { year, month } = plantDate(issuedAt);
  const seq = nextNumber(`SPJ|${year}${month}`);
  trip.spj = {
    id: `s-${nextSpjId++}`,
    spjNo: `SPJ/${SITE.code}/${year}${month}/${String(seq).padStart(5, "0")}`,
    barcodeToken: newToken(),
    issuedAt: issuedAt.toISOString(),
    validUntil: new Date(issuedAt.getTime() + settings.spjValidDays * 86_400_000).toISOString(),
    printCount: 0,
  };
  trip.status = "ISSUED";
}

function regNumber() {
  const { year, month } = plantDate();
  return `REG/${SITE.code}/${year}${month}/${String(nextNumber(`REG|${year}${month}`)).padStart(5, "0")}`;
}

const orderPlanned = (order, exceptRegistrationId = null) =>
  trips
    .filter((trip) => !DEAD_TRIP.includes(refreshTrip(trip).status) && trip.registrationId !== exceptRegistrationId)
    .flatMap((trip) => {
      const registration = registrationOf(trip);
      return trip.allocations
        .filter((allocation) => registration.allocations[allocation.seq - 1]?.deliveryOrderId === order.id)
        .map((allocation) => allocation.qtyPlanned ?? 0);
    })
    .reduce((sum, value) => sum + value, 0);

function publicOrder(order) {
  const contractRow = contracts.find((item) => item.id === order.contractId) ?? null;
  const destinationRow = destinations.find((item) => item.id === order.destinationId) ?? null;
  const planned = orderPlanned(order);
  const orderTrips = trips.filter((trip) =>
    registrationOf(trip).allocations.some((allocation) => allocation.deliveryOrderId === order.id),
  );
  return {
    id: order.id,
    doNo: order.doNo,
    doDate: order.doDate,
    status: order.status,
    contract: contractRow ? { id: contractRow.id, contractNo: contractRow.contractNo } : null,
    customerPoNo: order.customerPoNo,
    partner: ref(order.partner),
    product: { id: order.product.id, name: order.product.name, category: order.product.category },
    qty: order.qty,
    uom: order.uom,
    tolerancePct: order.tolerancePct,
    destination: destinationRow
      ? (({ id, name, address, district, regency, province }) => ({ id, name, address, district, regency, province }))(destinationRow)
      : null,
    deliveryFrom: order.deliveryFrom,
    deliveryUntil: order.deliveryUntil,
    transportTerms: order.transportTerms,
    transporter: ref(findPartner(order.transporterId)),
    truckCount: order.truckCount,
    truckCountBy: order.truckCountBy,
    qtyPlanned: planned,
    qtyRemaining: Math.max(order.qty - planned, 0),
    tripCount: orderTrips.filter((trip) => !DEAD_TRIP.includes(trip.status)).length,
    tolerancePct: order.tolerancePct ?? 0,
    remark: order.remark,
    sentAt: order.sentAt,
    acceptedAt: order.acceptedAt,
  };
}

/** A trip the way every route of the API answers it (TripView in apps/api trips/view.ts). */
function publicTrip(trip) {
  refreshTrip(trip);
  const registration = registrationOf(trip);
  const vehicleRow = vehicleOf(trip);
  const driverRow = driverOf(trip);
  const card = rfidCards.find((item) => item.tripId === trip.id) ?? null;
  return {
    id: trip.id,
    registrationId: trip.registrationId,
    seq: trip.seq,
    tripNo: trip.tripNo,
    status: trip.status,
    direction: registration.direction,
    flowCode: registration.flowCode,
    partner: ref(registration.partner),
    transporter: ref(findPartner(registration.transporterId)),
    currentStep: trip.currentStep,
    vehicle: vehicleRow
      ? { id: vehicleRow.id, plateNo: vehicleRow.plateNo, plateDisplay: vehicleRow.plateDisplay, vehicleTypeCode: vehicleRow.vehicleTypeCode }
      : null,
    driver: driverRow ? { id: driverRow.id, fullName: driverRow.fullName, licenceNo: driverRow.licenceNo, registryStatus: driverRow.registryStatus } : null,
    containerNo: trip.containerNo,
    plannedArrival: trip.plannedArrival,
    qtyPlanned: trip.qtyPlanned,
    docGrossKg: trip.docGrossKg,
    docTareKg: trip.docTareKg,
    docNetKg: trip.docNetKg,
    allocations: trip.allocations,
    spj: trip.spj,
    card: card ? { uid: card.uid, label: card.label } : null,
    checkedInAt: trip.checkedInAt,
    cancelReason: trip.cancelReason ?? null,
  };
}

/** A registration as GET /api/registrations/:id answers it; lists leave the trips out. */
function publicRegistration(registration, withTrips = true) {
  const own = tripsOf(registration);
  const allocations = registration.allocations.map((allocation) => {
    const contractRow = contracts.find((item) => item.id === allocation.contractId) ?? null;
    const order = deliveryOrders.find((item) => item.id === allocation.deliveryOrderId) ?? null;
    const source = contractRow ?? order;
    const qtyPlanned = own.reduce((sum, trip) => sum + (trip.allocations[allocation.seq - 1]?.qtyPlanned ?? 0), 0);
    return {
      seq: allocation.seq,
      contract: contractRow ? { id: contractRow.id, contractNo: contractRow.contractNo } : null,
      deliveryOrder: order ? { id: order.id, doNo: order.doNo } : null,
      contractNo: contractRow?.contractNo ?? contracts.find((item) => item.id === order?.contractId)?.contractNo ?? "-",
      doNo: order?.doNo ?? null,
      qtyPlanned,
      tolerancePct: source?.tolerancePct ?? 0,
      product: { id: source.product.id, name: source.product.name, category: source.product.category },
      partner: ref(source.partner),
    };
  });
  return {
    id: registration.id,
    regNo: registration.regNo,
    direction: registration.direction,
    flowCode: registration.flowCode,
    status: registration.status,
    partner: ref(registration.partner),
    transporter: ref(findPartner(registration.transporterId)),
    plannedDate: registration.plannedDate,
    truckCount: own.length,
    qtyTotal: allocations.reduce((sum, allocation) => sum + allocation.qtyPlanned, 0),
    uom: "Kg",
    closeCargo: registration.closeCargo,
    flexiBag: registration.flexiBag,
    remark: registration.remark,
    createdVia: registration.createdVia,
    createdBy: registration.createdBy,
    createdAt: registration.createdAt,
    submittedAt: registration.submittedAt,
    reviewedAt: registration.reviewedAt,
    reviewNote: registration.reviewNote,
    findings: registration.findings,
    allocations,
    ...(withTrips ? { trips: own.map(publicTrip) } : {}),
  };
}

/** A partner account reaches the registrations of its own company; staff reach all. */
const canReach = (user, registration) => user.kind === "INTERNAL" || registration.ownerPartnerId === user.partner?.id;

function documentWeights(letters) {
  const nets = letters.map((letter) => letter.originNetKg).filter((value) => value !== null);
  if (nets.length === 0) return { docGrossKg: null, docTareKg: null, docNetKg: null };
  const net = nets.reduce((sum, value) => sum + value, 0);
  const tares = letters.map((letter) => letter.originTareKg).filter((value) => value !== null && value > 0);
  const tare = tares.length > 0 ? Math.min(...tares) : null;
  return { docGrossKg: tare === null ? null : net + tare, docTareKg: tare, docNetKg: net };
}

function splitShares(total, count) {
  const share = Math.floor(total / count);
  return Array.from({ length: count }, (_, index) => (index === count - 1 ? total - share * (count - 1) : share));
}

/** Checks of section 2 that keep a registration saved but waiting for review. */
function computeFindings(registration) {
  const findings = [];
  const add = (code, message, extra = {}) => findings.push({ code, message, ...extra });
  for (const trip of tripsOf(registration)) {
    const tripSeq = trip.seq;
    const driverRow = driverOf(trip);
    const vehicleRow = vehicleOf(trip);
    // with the default policy only WARNING is a finding; BLACKLIST is refused before
    if (DRIVER_POLICY[driverRow.registryStatus] === "WARN") add("DRIVER_WARNING", `Supir ${driverRow.fullName} berstatus peringatan di VCF.`, { tripSeq });
    if (driverRow.licenceValidUntil < today()) add("LICENCE_EXPIRED", `SIM ${driverRow.fullName} habis berlaku ${driverRow.licenceValidUntil}.`, { tripSeq });
    if (!vehicleRow.verified) add("VEHICLE_UNVERIFIED", `Kendaraan ${vehicleRow.plateDisplay} belum diverifikasi logistik.`, { tripSeq });
    for (const code of publicVehicle(vehicleRow).expired) add(`${code}_EXPIRED`, `Surat ${code} kendaraan ${vehicleRow.plateDisplay} habis berlaku.`, { tripSeq });
    if (registration.direction === "OUT" && vehicleRow.capacityKg && trip.qtyPlanned > vehicleRow.capacityKg) {
      add("OVER_CAPACITY", `Rencana ${trip.qtyPlanned} kg melebihi daya angkut ${vehicleRow.plateDisplay}.`, { tripSeq });
    }
  }
  for (const allocation of registration.allocations) {
    const allocationSeq = allocation.seq;
    if (allocation.contractId) {
      const contractRow = contracts.find((item) => item.id === allocation.contractId);
      if (contractRow.uom !== "Kg") continue;
      const others = trips
        .filter((trip) => trip.registrationId !== registration.id && !DEAD_TRIP.includes(trip.status))
        .flatMap((trip) =>
          trip.allocations.filter((line) => registrationOf(trip).allocations[line.seq - 1]?.contractId === contractRow.id),
        )
        .reduce((sum, line) => sum + (line.originNetKg ?? 0), 0);
      const remaining = contractRow.qtyContract - others;
      for (const trip of tripsOf(registration)) {
        const net = trip.allocations[allocationSeq - 1]?.originNetKg ?? 0;
        if (net > remaining) add("OVER_CONTRACT", `Netto surat melebihi sisa kontrak ${contractRow.contractNo}.`, { tripSeq: trip.seq, allocationSeq });
      }
    } else {
      const order = deliveryOrders.find((item) => item.id === allocation.deliveryOrderId);
      const remaining = order.qty - orderPlanned(order, registration.id);
      if (allocation.qtyPlanned > remaining) add("OVER_DO", `Rencana melebihi sisa DO ${order.doNo}.`, { allocationSeq });
      for (const trip of tripsOf(registration)) {
        const arrival = trip.plannedArrival;
        if (arrival && (arrival < order.deliveryFrom || (order.deliveryUntil && arrival > order.deliveryUntil))) {
          add("OUTSIDE_DELIVERY_WINDOW", `Tanggal datang di luar masa kirim DO ${order.doNo}.`, { tripSeq: trip.seq, allocationSeq });
        }
      }
    }
  }
  return findings;
}

function approveRegistration(registration, reviewer = null, note = null) {
  registration.status = "APPROVED";
  if (reviewer) {
    registration.reviewedAt = nowIso();
    registration.reviewNote = note;
  }
  for (const trip of tripsOf(registration)) issueSpj(trip);
}

function submitRegistration(registration) {
  registration.submittedAt = nowIso();
  registration.findings = computeFindings(registration);
  const review = settings.registrationReview[registration.flowCode] === "ON_FAILED_CHECK";
  if (registration.findings.length === 0 || !review) {
    approveRegistration(registration);
  } else {
    registration.status = "SUBMITTED";
    for (const trip of tripsOf(registration)) trip.status = "READY";
  }
}

const problem = (status, code, message, fields) => ({ status, body: { error: { code, message, ...(fields ? { fields: fieldList(fields) } : {}) } } });
const validation = (fields) => problem(400, "VALIDATION", "Data yang dikirim tidak valid.", fields);

/**
 * Checks a registration request (POST, and PUT of a draft) without writing
 * anything. Returns { problem } or { plan } with everything resolved.
 */
function planRegistration(user, body) {
  const direction = body.direction;
  if (direction !== "IN" && direction !== "OUT") return { problem: validation({ direction: "Arah harus IN atau OUT." }) };
  const isPartner = user.kind === "PARTNER";
  // mayWrite in apps/api registrations/service.ts: a partner registers incoming as a supplier, outgoing as a transporter
  const company = accountPartner(user.partner);
  if (isPartner && !(direction === "IN" ? company?.isSupplier : company?.isTransporter)) {
    return { problem: problem(403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.") };
  }
  const submit = body.submit === true;
  const allocationsIn = Array.isArray(body.allocations) ? body.allocations : [];
  const tripsIn = Array.isArray(body.trips) ? body.trips : [];
  const fields = {};
  if (allocationsIn.length === 0) fields.allocations = "Pilih minimal satu kontrak atau DO.";
  if (tripsIn.length === 0) fields.trips = "Isi minimal satu truk.";
  if (direction === "IN" && tripsIn.length !== 1) fields.trips = "Registrasi masuk berisi tepat satu truk.";
  if (Object.keys(fields).length > 0) return { problem: validation(fields) };

  // allocations
  const allocations = [];
  for (const [index, entry] of allocationsIn.entries()) {
    if (direction === "IN") {
      const row = contracts.find((item) => item.id === entry?.contractId);
      if (!row || row.direction !== "IN" || row.state !== "OPEN" || (isPartner && row.partner.id !== user.partner.id)) {
        return { problem: problem(409, "CONTRACT_NOT_AVAILABLE", "Kontrak tidak ditemukan, tidak terbuka, atau bukan milik perusahaan Anda.") };
      }
      allocations.push({ seq: index + 1, contractId: row.id, deliveryOrderId: null, qtyPlanned: null, source: row });
    } else {
      const order = deliveryOrders.find((item) => item.id === entry?.deliveryOrderId);
      if (!order || order.status !== "ACCEPTED" || (isPartner && order.transporterId !== user.partner.id)) {
        return { problem: problem(409, "DO_NOT_AVAILABLE", "DO tidak ditemukan, belum diterima, atau bukan untuk perusahaan Anda.") };
      }
      const qty = entry.qtyPlanned ?? publicOrder(order).qtyRemaining;
      if (!Number.isInteger(qty) || qty <= 0) {
        return { problem: validation({ [`allocations.${index}.qtyPlanned`]: qty > 0 ? "Quantity harus angka lebih dari 0." : "Sisa DO sudah habis. Isi quantity." }) };
      }
      allocations.push({ seq: index + 1, contractId: null, deliveryOrderId: order.id, qtyPlanned: qty, source: order });
    }
  }
  const keys = allocations.map((allocation) => allocation.source.id);
  if (new Set(keys).size !== keys.length) return { problem: validation({ allocations: "Kontrak atau DO yang sama dipilih dua kali." }) };
  const flows = new Set(allocations.map((allocation) => settings.flowByCategory[direction][allocation.source.product.category] ?? `${direction}_OTHER`));
  if (flows.size > 1) return { problem: validation({ allocations: "Semua kontrak atau DO dalam satu registrasi harus satu jalur barang." }) };
  const [flowCode] = flows;
  const maxPerTrip = settings.maxContractsPerTrip[flowCode];
  if (maxPerTrip !== undefined && allocations.length > maxPerTrip) {
    return { problem: validation({ allocations: `Satu truk paling banyak membawa ${maxPerTrip} kontrak atau DO pada jalur ini.` }) };
  }
  if (direction === "OUT" && new Set(allocations.map((allocation) => allocation.source.transporterId)).size > 1) {
    return { problem: validation({ allocations: "Semua DO dalam satu registrasi harus untuk transporter yang sama." }) };
  }

  // transporter
  let transporterId = null;
  if (direction === "OUT") {
    transporterId = allocations[0].source.transporterId;
  } else if (body.transporterId) {
    const transporter = findPartner(body.transporterId);
    if (!transporter || partnerRole(transporter) !== "transporter") {
      return { problem: validation({ transporterId: "Transporter harus partner transporter." }) };
    }
    transporterId = transporter.id;
  }

  // trips
  const planned = [];
  const usedVehicles = new Set();
  const usedDrivers = new Set();
  for (const [index, entry] of tripsIn.entries()) {
    const at = `trips.${index}`;
    const tripFields = {};
    let vehicleRow = null;
    let newVehicle = null;
    if (entry?.vehicle?.id) {
      vehicleRow = vehicles.find((item) => item.id === entry.vehicle.id && item.isActive) ?? null;
      if (!vehicleRow) tripFields[`${at}.vehicle.id`] = "Kendaraan tidak ditemukan.";
    } else {
      const key = plateKey(entry?.vehicle?.plateDisplay);
      // a plate that already exists uses that vehicle, as a licence number does
      vehicleRow = vehicles.find((item) => item.plateNo === key) ?? null;
      if (!vehicleRow) {
        if (!entry?.vehicle?.plateDisplay) tripFields[`${at}.vehicle.plateDisplay`] = "Plat nomor wajib diisi.";
        else if (!/^[A-Z0-9]{3,12}$/.test(key)) tripFields[`${at}.vehicle.plateDisplay`] = "Plat nomor harus 3 sampai 12 huruf atau angka.";
        if (!vehicleTypes.some((type) => type.code === entry?.vehicle?.vehicleTypeCode)) tripFields[`${at}.vehicle.vehicleTypeCode`] = "Jenis kendaraan wajib diisi.";
        newVehicle = entry?.vehicle ?? {};
      }
    }
    let driverRow = null;
    let newDriver = null;
    if (entry?.driver?.id) {
      driverRow = drivers.find((item) => item.id === entry.driver.id && item.isActive) ?? null;
      if (!driverRow) tripFields[`${at}.driver.id`] = "Supir tidak ditemukan.";
    } else {
      const licenceNo = plateKey(entry?.driver?.licenceNo);
      driverRow = licenceNo ? drivers.find((item) => item.licenceNo === licenceNo) ?? null : null;
      if (!driverRow) {
        const labels = { licenceNo: "Nomor SIM", fullName: "Nama supir", licenceClass: "Jenis SIM" };
        for (const name of ["licenceNo", "fullName", "licenceClass"]) {
          if (!optionalText(entry?.driver?.[name])) tripFields[`${at}.driver.${name}`] = `${labels[name]} wajib diisi.`;
        }
        if (!isDate(entry?.driver?.licenceValidUntil)) tripFields[`${at}.driver.licenceValidUntil`] = "Masa berlaku SIM wajib diisi.";
        newDriver = { ...(entry?.driver ?? {}), licenceNo };
      }
    }
    const typeCode = vehicleRow?.vehicleTypeCode ?? newVehicle?.vehicleTypeCode;
    if (vehicleTypes.find((type) => type.code === typeCode)?.needsContainerNo && !optionalText(entry?.containerNo)) {
      tripFields[`${at}.containerNo`] = "Nomor kontainer wajib diisi untuk jenis kendaraan ini.";
    }
    const letters = [];
    if (direction === "IN") {
      for (const allocation of allocations) {
        const sent = entry?.letters ?? [];
        const letterIndex = sent.findIndex((item) => item?.allocationSeq === allocation.seq);
        const letter = sent[letterIndex] ?? {};
        // the API names a letter by its place in the list it was sent in
        const where = `${at}.letters.${letterIndex === -1 ? allocation.seq - 1 : letterIndex}`;
        const kg = (name) => {
          const value = letter[name];
          if (value === undefined || value === null) return null;
          if (!Number.isInteger(value) || value <= 0) tripFields[`${where}.${name}`] = "Harus bilangan bulat lebih dari 0.";
          return value;
        };
        const line = {
          seq: allocation.seq,
          qtyPlanned: null,
          handoverNo: optionalText(letter.handoverNo),
          spbNo: optionalText(letter.spbNo),
          spbDate: isDate(letter.spbDate) ? letter.spbDate : null,
          originTicketNo: optionalText(letter.originTicketNo),
          originGrossKg: kg("originGrossKg"),
          originTareKg: kg("originTareKg"),
          originNetKg: kg("originNetKg"),
          quality: {},
        };
        if (line.originGrossKg !== null && line.originTareKg !== null && line.originNetKg !== null && line.originNetKg !== line.originGrossKg - line.originTareKg) {
          tripFields[`${where}.originNetKg`] = "Netto asal harus sama dengan bruto dikurangi tarra.";
        }
        for (const [code, value] of Object.entries(letter.quality ?? {})) {
          const parameter = qualityParameters.find((item) => item.code === code);
          if (!parameter) tripFields[`${where}.quality.${code}`] = `Parameter spek ${code} tidak dikenal.`;
          else if (typeof value !== "number" || value < parameter.minValid || value > parameter.maxValid) {
            tripFields[`${where}.quality.${code}`] = `${parameter.name} harus antara ${parameter.minValid} dan ${parameter.maxValid}.`;
          } else line.quality[code] = value;
        }
        line.qtyPlanned = line.originNetKg;
        letters.push(line);
      }
    }
    if (Object.keys(tripFields).length > 0) return { problem: validation(tripFields) };
    const vehicleKey = vehicleRow?.id ?? plateKey(newVehicle?.plateDisplay);
    const driverKey = driverRow?.id ?? newDriver?.licenceNo;
    if (usedVehicles.has(vehicleKey)) return { problem: problem(409, "DUPLICATE_VEHICLE", "Satu kendaraan dipakai dua kali dalam registrasi ini.") };
    if (usedDrivers.has(driverKey)) return { problem: problem(409, "DUPLICATE_DRIVER", "Satu supir dipakai dua kali dalam registrasi ini.") };
    // checkRegistration in apps/api: the registry policy, then a local block
    if (driverRow && DRIVER_POLICY[driverRow.registryStatus] === "BLOCK") {
      return { problem: problem(409, "DRIVER_BLACKLISTED", `Supir ${driverRow.fullName} masuk daftar hitam VCF.`) };
    }
    if (driverRow?.blocked) return { problem: problem(409, "DRIVER_BLOCKED", `Supir ${driverRow.fullName} sedang diblokir.`) };
    usedVehicles.add(vehicleKey);
    usedDrivers.add(driverKey);
    planned.push({ entry, vehicleRow, newVehicle, driverRow, newDriver, letters });
  }

  if (direction === "OUT" && submit && (typeof body.closeCargo !== "boolean" || typeof body.flexiBag !== "boolean")) {
    const missing = {};
    if (typeof body.closeCargo !== "boolean") missing.closeCargo = "Close cargo wajib dijawab sebelum dikirim.";
    if (typeof body.flexiBag !== "boolean") missing.flexiBag = "Flexi bag wajib dijawab sebelum dikirim.";
    return { problem: validation(missing) };
  }

  return {
    plan: {
      direction,
      submit,
      flowCode,
      partner: allocations[0].source.partner,
      transporterId,
      plannedDate: isDate(body.plannedDate) ? body.plannedDate : null,
      remark: optionalText(body.remark),
      closeCargo: typeof body.closeCargo === "boolean" ? body.closeCargo : null,
      flexiBag: typeof body.flexiBag === "boolean" ? body.flexiBag : null,
      allocations: allocations.map(({ seq, contractId, deliveryOrderId, qtyPlanned }) => ({ seq, contractId, deliveryOrderId, qtyPlanned })),
      trips: planned,
    },
  };
}

/** Writes a checked plan: creates vehicles and drivers in place, then the trips. */
function writeRegistration(registration, plan, user) {
  Object.assign(registration, {
    direction: plan.direction,
    flowCode: plan.flowCode,
    partner: plan.partner,
    transporterId: plan.transporterId,
    plannedDate: plan.plannedDate,
    remark: plan.remark,
    closeCargo: plan.closeCargo,
    flexiBag: plan.flexiBag,
    allocations: plan.allocations,
    findings: [],
  });
  for (const trip of tripsOf(registration)) trips.splice(trips.indexOf(trip), 1);
  const count = plan.trips.length;
  const shares = plan.allocations.map((allocation) => (allocation.qtyPlanned === null ? null : splitShares(allocation.qtyPlanned, count)));
  plan.trips.forEach((item, index) => {
    let vehicleRow = item.vehicleRow;
    if (!vehicleRow) {
      const source = item.newVehicle;
      vehicleRow = {
        id: `v-${nextVehicleId++}`,
        plateNo: plateKey(source.plateDisplay),
        plateDisplay: String(source.plateDisplay).trim().replace(/\s+/g, " ").toUpperCase(),
        vehicleTypeCode: source.vehicleTypeCode,
        // A vehicle entered by a partner belongs to the transporter of the registration.
        owner: findPartner(plan.transporterId) ?? (user.kind === "PARTNER" ? user.partner : null),
        ownership: null,
        capacityKg: numberOrNull(source.capacityKg),
        productionYear: numberOrNull(source.productionYear),
        tareKg: numberOrNull(source.tareKg),
        stnkValidUntil: isDate(source.stnkValidUntil) ? source.stnkValidUntil : null,
        taxValidUntil: isDate(source.taxValidUntil) ? source.taxValidUntil : null,
        kirValidUntil: isDate(source.kirValidUntil) ? source.kirValidUntil : null,
        isActive: true,
        verified: user.kind === "INTERNAL",
      };
      vehicles.unshift(vehicleRow);
    }
    let driverRow = item.driverRow;
    if (!driverRow) {
      const source = item.newDriver;
      driverRow = {
        id: `d-${nextDriverId++}`,
        fullName: source.fullName.trim(),
        licenceNo: source.licenceNo,
        licenceClass: source.licenceClass.trim(),
        licenceValidUntil: source.licenceValidUntil,
        phone: optionalText(source.phone),
        registryStatus: "UNKNOWN",
        registrySyncedAt: null,
        registryPush: "PENDING",
        registryPushError: null,
        isActive: true,
      };
      drivers.unshift(driverRow);
    }
    const lines =
      plan.direction === "IN"
        ? item.letters
        : plan.allocations.map((allocation, at) => ({
            seq: allocation.seq,
            qtyPlanned: shares[at][index],
            handoverNo: optionalText(item.entry.handoverNo),
            spbNo: null,
            spbDate: null,
            originTicketNo: null,
            originGrossKg: null,
            originTareKg: null,
            originNetKg: null,
            quality: {},
          }));
    const weights = plan.direction === "IN" ? documentWeights(lines) : { docGrossKg: null, docTareKg: null, docNetKg: null };
    trips.push({
      id: `trip-${nextTripId++}`,
      registrationId: registration.id,
      seq: index + 1,
      tripNo: null,
      status: "DRAFT",
      vehicleId: vehicleRow.id,
      driverId: driverRow.id,
      containerNo: optionalText(item.entry.containerNo)?.toUpperCase() ?? null,
      plannedArrival: isDate(item.entry.plannedArrival) ? item.entry.plannedArrival : plan.plannedDate,
      handoverNo: optionalText(item.entry.handoverNo),
      qtyPlanned: lines.reduce((sum, line) => sum + (line.qtyPlanned ?? 0), 0) || null,
      ...weights,
      allocations: lines,
      spj: null,
      revokedTokens: [],
      checkedInAt: null,
      currentStep: null,
      steps: [],
    });
  });
}

function seedRegistration({ partner, transporter, vehicleId, driverId, contractNo, plannedDate, issuedDaysAgo }) {
  const registration = {
    id: `r-${nextRegistrationId++}`,
    regNo: regNumber(),
    status: "DRAFT",
    createdVia: "OPERATOR",
    createdBy: { id: "u-2", fullName: "Petugas Pos Contoh" },
    createdAt: daysAgoIso(issuedDaysAgo),
    ownerPartnerId: partner.id,
    submittedAt: daysAgoIso(issuedDaysAgo),
    reviewedAt: null,
    reviewNote: null,
  };
  registrations.push(registration);
  const source = contracts.find((item) => item.contractNo === contractNo);
  const letter = { seq: 1, qtyPlanned: 24000, handoverNo: null, spbNo: "SPB-CONTOH-01", spbDate: plannedDate, originTicketNo: null, originGrossKg: 34000, originTareKg: 10000, originNetKg: 24000, quality: { FFA: 3.2 } };
  writeRegistration(
    registration,
    {
      direction: "IN",
      flowCode: "IN_CPO",
      partner,
      transporterId: transporter.id,
      plannedDate,
      remark: null,
      closeCargo: null,
      flexiBag: null,
      allocations: [{ seq: 1, contractId: source.id, deliveryOrderId: null, qtyPlanned: null }],
      trips: [{ entry: {}, vehicleRow: vehicles.find((item) => item.id === vehicleId), driverRow: drivers.find((item) => item.id === driverId), letters: [letter] }],
    },
    users[1],
  );
  registration.status = "APPROVED";
  for (const trip of tripsOf(registration)) issueSpj(trip, new Date(Date.now() - issuedDaysAgo * 86_400_000));
}

// Expected today at the post, and one whose SPJ ran out last week. MOCK_FLOW=empty
// leaves them out, for looking at Beranda without any truck.
if (process.env.MOCK_FLOW !== "empty") {
  seedRegistration({ partner: partners.pksB, transporter: partners.transporterB, vehicleId: "v-3", driverId: "d-2", contractNo: "0125/CONTOH/CPO/XI/2026", plannedDate: plantDate().iso, issuedDaysAgo: 0 });
  seedRegistration({ partner: partners.pksB, transporter: partners.transporterB, vehicleId: "v-3", driverId: "d-6", contractNo: "0125/CONTOH/CPO/XI/2026", plannedDate: daysFromNow(-9), issuedDaysAgo: 9 });
}

// MOCK_FLOW=sample: trucks spread over the stages of the plant (expected today,
// inside at a step, done today), for looking at the truck flow on Beranda. Off
// by default, so the smoke test keeps its own counts. Invented like the rest.
if (process.env.MOCK_FLOW === "sample") seedFlowSample();

function seedFlowSample() {
  const today = plantDate().iso;
  // Trucks still to come use a vehicle and drivers that are not inside, so the post can check them in.
  const comingDrivers = ["d-1", "d-7"];
  const insideDrivers = ["d-5", "d-6", "d-8", "d-9", "d-10"];
  const plan = [
    ["upcoming", "IN", 3], ["upcoming", "OUT", 2],
    ["WEIGH_1", "IN", 2], ["WEIGH_1", "OUT", 1],
    ["QC", "IN", 4],
    ["UNLOADING", "IN", 6], ["LOADING", "OUT", 2],
    ["SEAL", "OUT", 1],
    ["WEIGH_2", "IN", 2], ["WEIGH_2", "OUT", 1],
    ["CHECK_OUT", "IN", 1],
    ["done", "IN", 3], ["done", "OUT", 1],
  ];
  let n = 0;
  for (const [stage, direction, count] of plan) {
    for (let index = 0; index < count; index += 1) {
      n += 1;
      const before = registrations.length;
      seedRegistration({
        partner: partners.pksB,
        transporter: partners.transporterB,
        vehicleId: stage === "upcoming" ? "v-1" : `v-${(n % 3) + 3}`,
        driverId: stage === "upcoming" ? comingDrivers[n % comingDrivers.length] : insideDrivers[n % insideDrivers.length],
        contractNo: "0125/CONTOH/CPO/XI/2026",
        plannedDate: today,
        issuedDaysAgo: 0,
      });
      const registration = registrations[before];
      if (direction === "OUT") Object.assign(registration, { direction: "OUT", flowCode: "OUT_BULK" });
      if (stage === "upcoming") continue;
      const flow = flowSteps[registration.flowCode];
      const checkedIn = new Date(Date.now() - (30 + n * 7) * 60_000);
      const { year, month, day, iso } = plantDate(checkedIn);
      const at = flow.indexOf(stage);
      for (const trip of tripsOf(registration)) {
        Object.assign(trip, {
          status: stage === "done" ? "COMPLETED" : "IN_PROCESS",
          checkedInAt: checkedIn.toISOString(),
          tripNo: `${year}${month}${day}-${String(nextNumber(`TRIP|${iso}`)).padStart(4, "0")}`,
          currentStep: stage === "done" ? null : stage,
          steps: flow.map((code, step) => ({ code, status: stage === "done" || step < at ? "DONE" : step === at ? "READY" : "PENDING" })),
        });
      }
    }
  }
}

const GATE_MESSAGES = {
  SPJ_EXPIRED: "SPJ sudah lewat masa berlaku. Minta terbit ulang.",
  SPJ_REVOKED: "SPJ ini sudah dicabut. Pakai SPJ yang terbaru.",
  ALREADY_CHECKED_IN: "Truk ini sudah check-in.",
  CARD_UNKNOWN: "Kartu belum terdaftar.",
  CARD_IN_USE: "Kartu sedang dipakai truk lain.",
  CARD_NOT_AVAILABLE: "Kartu berstatus hilang atau tidak dipakai lagi.",
  VEHICLE_INSIDE: "Kendaraan ini masih tercatat di dalam pabrik.",
  DRIVER_INSIDE: "Supir ini masih tercatat di dalam pabrik.",
};

/** The registry policy for a driver: { code, level, message } or null (registryVerdict in apps/api). */
function registryVerdict(driverRow) {
  const action = DRIVER_POLICY[driverRow.registryStatus] ?? "ALLOW";
  if (action === "ALLOW") return null;
  const code = { BLACKLIST: "DRIVER_BLACKLISTED", WARNING: "DRIVER_WARNING", UNKNOWN: "DRIVER_NOT_IN_REGISTRY" }[driverRow.registryStatus];
  return { code, level: action, message: `Supir ${driverRow.fullName} ditandai ${driverRow.registryStatus} di VCF.` };
}

const insideElsewhere = (trip, key) => trips.some((other) => other !== trip && INSIDE.includes(other.status) && other[key] === trip[key]);

/** Checks the post shows after a scan, in the order of GET /api/gate/spj/:token. */
function gateChecks(trip) {
  const checks = [];
  const block = (code) => checks.push({ code, level: "BLOCK", message: GATE_MESSAGES[code] ?? code });
  if (trip.revoked) block("SPJ_REVOKED");
  else if (trip.status === "EXPIRED") block("SPJ_EXPIRED");
  if (ARRIVED.includes(trip.status)) block("ALREADY_CHECKED_IN");
  else if (!trip.revoked && trip.status === "ISSUED") {
    const driverRow = driverOf(trip);
    const vehicleRow = vehicleOf(trip);
    const verdict = registryVerdict(driverRow);
    if (verdict) checks.push(verdict);
    if (driverRow.blocked) checks.push({ code: "DRIVER_BLOCKED", level: "BLOCK", message: `Supir ${driverRow.fullName} sedang diblokir.` });
    if (driverRow.licenceValidUntil < today()) {
      checks.push({ code: "LICENCE_EXPIRED", level: "WARN", message: `SIM ${driverRow.fullName} habis berlaku ${driverRow.licenceValidUntil}.` });
    }
    if (!vehicleRow.verified) checks.push({ code: "VEHICLE_UNVERIFIED", level: "WARN", message: `Kendaraan ${vehicleRow.plateDisplay} belum diverifikasi logistik.` });
    for (const code of publicVehicle(vehicleRow).expired) {
      checks.push({ code: `${code}_EXPIRED`, level: "WARN", message: `Surat ${code} kendaraan ${vehicleRow.plateDisplay} habis berlaku.` });
    }
    if (insideElsewhere(trip, "vehicleId")) block("VEHICLE_INSIDE");
    if (insideElsewhere(trip, "driverId")) block("DRIVER_INSIDE");
  }
  return checks;
}

/** Revokes the active SPJ of a trip: its token stays known so a scan answers SPJ_REVOKED. */
function revokeSpj(trip) {
  if (!trip.spj) return;
  trip.revokedTokens.push(trip.spj.barcodeToken);
  trip.spj = null;
}

function findByToken(rawToken) {
  const token = normalizeToken(rawToken);
  const trip = trips.find((item) => item.spj?.barcodeToken === token);
  if (trip) return refreshTrip(trip);
  const revoked = trips.find((item) => item.revokedTokens.includes(token));
  return revoked ? { ...revoked, revoked: true } : null;
}

function releaseCard(trip, reason) {
  const card = rfidCards.find((item) => item.tripId === trip.id);
  if (!card) return;
  card.tripId = null;
  card.status = reason === "LOST" ? "LOST" : reason === "REPLACED" ? "RETIRED" : "AVAILABLE";
  const assignment = cardAssignments.find((item) => item.cardId === card.id && item.tripId === trip.id && !item.releasedAt);
  if (assignment) Object.assign(assignment, { releasedAt: nowIso(), releaseReason: reason });
}

function bindCard(trip, card) {
  card.status = "IN_USE";
  card.tripId = trip.id;
  cardAssignments.push({ cardId: card.id, tripId: trip.id, assignedAt: nowIso(), releasedAt: null, releaseReason: null });
}

/** Card checks shared by check-in and replace: null when the card can be bound. */
function cardProblem(card) {
  if (!card) return problem(409, "CARD_UNKNOWN", GATE_MESSAGES.CARD_UNKNOWN);
  if (card.status === "IN_USE") return problem(409, "CARD_IN_USE", GATE_MESSAGES.CARD_IN_USE);
  if (card.status !== "AVAILABLE") return problem(409, "CARD_NOT_AVAILABLE", GATE_MESSAGES.CARD_NOT_AVAILABLE);
  return null;
}

const reply = (request, response, outcome) => send(request, response, outcome.status, outcome.body);

/**
 * Checks a delivery order body and writes it. Returns an error answer, or null
 * when saved. A contract fills partner, product, unit and customer PO.
 */
function applyOrder(order, body, creating) {
  const fields = {};
  const next = {};
  const has = (name) => creating || name in body;
  if (has("contractId")) {
    if (body.contractId) {
      const source = contracts.find((item) => item.id === body.contractId && item.direction === "OUT");
      if (!source) fields.contractId = "Unknown sales contract";
      else Object.assign(next, { contractId: source.id, partner: source.partner, product: source.product, uom: source.uom, customerPoNo: source.customerPoNo, tolerancePct: source.tolerancePct });
    } else {
      next.contractId = null;
    }
  }
  const contractChosen = (next.contractId ?? (creating ? null : order.contractId)) !== null;
  if (!contractChosen && (has("partnerId") || has("productId"))) {
    const partner = findPartner(body.partnerId);
    const product = Object.values(products).find((item) => item.id === body.productId);
    if (!partner || partnerRole(partner) !== "customer") fields.partnerId = "Required without a contract";
    if (!product) fields.productId = "Required without a contract";
    Object.assign(next, { partner, product });
  }
  if (has("doNo")) next.doNo = optionalText(body.doNo);
  for (const name of ["doDate", "deliveryFrom"]) {
    if (!has(name)) continue;
    if (!isDate(body[name])) fields[name] = "Must be a date";
    next[name] = body[name];
  }
  if (has("deliveryUntil")) {
    if (body.deliveryUntil != null && !isDate(body.deliveryUntil)) fields.deliveryUntil = "Must be a date";
    next.deliveryUntil = body.deliveryUntil ?? null;
  }
  if (has("qty")) {
    if (typeof body.qty !== "number" || !(body.qty > 0)) fields.qty = "Positive number";
    next.qty = body.qty;
  }
  if (has("destinationId")) {
    if (!destinations.some((item) => item.id === body.destinationId)) fields.destinationId = "Unknown destination";
    next.destinationId = body.destinationId;
  }
  if (has("transporterId")) {
    if (body.transporterId && partnerRole(findPartner(body.transporterId) ?? { id: "p-0" }) !== "transporter") fields.transporterId = "Unknown transporter";
    next.transporterId = body.transporterId ?? null;
  }
  if (has("truckCount")) {
    if (body.truckCount != null && !(Number.isInteger(body.truckCount) && body.truckCount > 0)) fields.truckCount = "Positive whole number";
    next.truckCount = body.truckCount ?? null;
    next.truckCountBy = body.truckCount != null ? "ADMIN" : null;
  }
  for (const name of ["customerPoNo", "transportTerms", "remark"]) {
    if (has(name) && !(name === "customerPoNo" && contractChosen && body[name] == null)) next[name] = optionalText(body[name]);
  }
  if (has("tolerancePct") && body.tolerancePct != null) next.tolerancePct = body.tolerancePct;
  if (has("uom") && body.uom && !contractChosen) next.uom = body.uom;
  if (creating) {
    next.uom ??= "Kg";
    next.tolerancePct ??= null;
  }
  if (Object.keys(fields).length > 0) return problem(400, "VALIDATION", "Invalid request body", fields);
  if (next.doNo && deliveryOrders.some((item) => item !== order && item.doNo === next.doNo)) {
    return problem(409, "DUPLICATE", "A delivery order with this number exists");
  }
  if (creating && !next.doNo) next.doNo = doNumber();
  if (!creating && "doNo" in next && !next.doNo) delete next.doNo;
  Object.assign(order, next);
  return null;
}

// --- routes -----------------------------------------------------------------

const routes = {
  "GET /api/health": (request, response) => send(request, response, 200, { status: "ok" }),

  "POST /api/auth/login": async (request, response) => {
    const { username, password } = await readJson(request);
    const key = String(username ?? "").toLowerCase();
    const recent = (failedLogins.get(key) ?? []).filter((time) => time > Date.now() - 60_000);
    if (recent.length >= 5) {
      return fail(request, response, 429, "TOO_MANY_ATTEMPTS", "Too many failed sign-in attempts");
    }
    const user = users.find((candidate) => candidate.username === key && candidate.password && candidate.isActive);
    if (!user || user.password !== password) {
      failedLogins.set(key, [...recent, Date.now()]);
      return fail(request, response, 401, "INVALID_CREDENTIALS", "Wrong username or password");
    }
    failedLogins.delete(key);
    return startSession(request, response, user);
  },

  // Stands in for the round trip through the company portal.
  "GET /api/auth/sso/start": (request, response, url) => {
    const user = users.find((candidate) => candidate.username === (url.searchParams.get("as") ?? "admin.contoh"));
    const ticket = newId();
    if (user?.kind === "INTERNAL" && user.isActive) {
      tickets.set(ticket, { userId: user.id, expiresAt: Date.now() + TICKET_TTL_MS });
    }
    const path = url.searchParams.get("to") === "callback" ? "/auth/sso" : "/";
    const query = new URLSearchParams({ token: ticket, appId: APP_ID });
    response.writeHead(302, { location: `${WEB_ORIGIN}${path}?${query}`, "cache-control": "no-store" });
    response.end();
    return 302;
  },

  "POST /api/auth/sso/exchange": async (request, response) => {
    if (!SSO_CONFIGURED) return fail(request, response, 503, "NOT_CONFIGURED", "SSO is not configured");
    const { token, appId } = await readJson(request);
    const ticket = typeof token === "string" ? tickets.get(token) : null;
    if (typeof token === "string") tickets.delete(token); // one use only
    if (!ticket || ticket.expiresAt <= Date.now() || appId !== APP_ID) {
      return fail(request, response, 401, "SSO_REJECTED", "The portal rejected this ticket");
    }
    return startSession(request, response, users.find((user) => user.id === ticket.userId));
  },

  "POST /api/auth/refresh": (request, response) => {
    const userId = sessions.get(readCookie(request, REFRESH_COOKIE) ?? "");
    if (!userId) return fail(request, response, 401, "UNAUTHENTICATED", "No session");
    return send(request, response, 200, { accessToken: issueAccessToken(userId) });
  },

  "POST /api/auth/logout": (request, response) => {
    const refreshId = readCookie(request, REFRESH_COOKIE);
    const userId = refreshId ? sessions.get(refreshId) : null;
    if (refreshId) sessions.delete(refreshId);
    for (const [token, entry] of accessTokens) if (entry.userId === userId) accessTokens.delete(token);
    return send(request, response, 204, undefined, { "set-cookie": refreshCookie("", 0) });
  },

  "GET /api/me": (request, response) => {
    const user = authenticate(request, response);
    return user ? send(request, response, 200, { user: publicUser(user) }) : 401;
  },

  "GET /api/contracts": (request, response, url) => {
    const user = guard(request, response, [["contracts", "VIEW"]]);
    if (!user) return 0;
    const direction = url.searchParams.get("direction");
    if (direction !== "IN" && direction !== "OUT") return invalid(request, response, { direction: "Arah harus IN atau OUT." });
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const includeClosed = ["true", "1"].includes(url.searchParams.get("includeClosed") ?? "");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const matches = contracts.filter(
      (item) =>
        item.direction === direction &&
        (includeClosed || item.state !== "CLOSED") &&
        // A partner account only sees the contracts of its own company.
        (user.kind !== "PARTNER" || item.partner.id === user.partner.id) &&
        (!q || item.contractNo.toLowerCase().includes(q) || item.partner.name.toLowerCase().includes(q)),
    );
    return send(request, response, 200, { items: matches.slice(0, limit), total: matches.length });
  },

  "POST /api/admin/sync/odoo": async (request, response) => {
    if (!guard(request, response, [["contracts", "EDIT"]], { staffOnly: true })) return 0;
    if (!ODOO_CONFIGURED) return fail(request, response, 503, "NOT_CONFIGURED", "Odoo belum diatur di server.");
    if (syncRunning) return fail(request, response, 409, "SYNC_RUNNING", "Sinkronisasi Odoo sedang berjalan.");

    syncRunning = true;
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, SYNC_MS));
    syncCount += 1;
    const now = new Date().toISOString();
    for (const item of contracts) item.syncedAt = now;
    // Each sync "finds" one new contract, so the list visibly changes afterwards.
    const number = String(127 + syncCount).padStart(4, "0");
    contracts.push(contract(`${number}/CONTOH/CPO/XI/2026`, "IN", partners.pksB, products.cpo, 400000, { syncedAt: now }));
    const result = { contracts: contracts.length, partners: Object.keys(partners).length, products: Object.keys(products).length, skipped: 1 };
    for (const entity of ["partners", "products", "contracts"]) {
      syncRuns.unshift({
        id: nextRunId++,
        entity,
        status: "SUCCESS",
        startedAt: new Date(started).toISOString(),
        finishedAt: now,
        rowsUpserted: result[entity],
        error: null,
      });
    }
    syncRunning = false;
    return send(request, response, 200, { ...result, durationMs: Date.now() - started });
  },

  "GET /api/admin/sync/runs": (request, response, url) => {
    if (!guard(request, response, [["contracts", "VIEW"], ["drivers", "VIEW"]], { staffOnly: true })) return 0;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    return send(request, response, 200, { items: syncRuns.slice(0, limit) });
  },

  // --- users and their module permissions -----------------------------------

  "GET /api/admin/users": (request, response, url) => {
    if (!guard(request, response, [["users", "VIEW"]])) return 0;
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = users.filter((user) => !q || includesText(user.fullName, q) || includesText(user.username, q));
    return page(request, response, url, matches.map(adminUser));
  },

  "GET /api/admin/modules": (request, response) => {
    if (!guard(request, response, [["users", "VIEW"]])) return 0;
    return send(request, response, 200, { items: modules });
  },

  // Replaces every permission of the account: a module left out or set to null is taken away.
  "PUT /api/admin/users/:id/permissions": async (request, response, url, id) => {
    if (!guard(request, response, [["users", "EDIT"]])) return 0;
    const target = users.find((user) => user.id === id);
    if (!target) return fail(request, response, 404, "NOT_FOUND", "Akun tidak ditemukan.");
    const { permissions } = await readJson(request);
    if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
      return invalid(request, response, { permissions: "permissions harus berupa objek kode modul ke tingkat." });
    }
    const wanted = {};
    const fields = [];
    for (const [code, level] of Object.entries(permissions)) {
      const known = modules.find((item) => item.code === code);
      const field = `permissions.${code}`;
      if (level !== null && !["VIEW", "CREATE", "EDIT"].includes(level)) fields.push({ field, message: "Tingkat harus VIEW, CREATE, EDIT, atau null." });
      else if (!known) fields.push({ field, message: `Modul ${code} tidak ada.` });
      else if (level === null) continue;
      else if (!known.levels.includes(level)) fields.push({ field, message: `Tingkat ${level} tidak berlaku untuk modul ${code}.` });
      else if (target.kind === "PARTNER" && !known.partnerAllowed) fields.push({ field, message: `Modul ${code} tidak bisa diberikan ke akun partner.` });
      else wanted[code] = level;
    }
    if (fields.length > 0) return invalid(request, response, fields);
    const before = target.permissions;
    target.permissions = wanted;
    if (adminCount() === 0) {
      target.permissions = before;
      return fail(request, response, 409, "LAST_ADMIN", "Harus ada sedikitnya satu akun internal aktif yang bisa mengatur hak akses.");
    }
    return send(request, response, 200, { user: adminUser(target) });
  },

  "PATCH /api/admin/users/:id": async (request, response, url, id) => {
    const admin = guard(request, response, [["users", "EDIT"]]);
    if (!admin) return 0;
    const { isActive } = await readJson(request);
    if (typeof isActive !== "boolean") return invalid(request, response, { isActive: "isActive harus true atau false." });
    if (id === admin.id) return fail(request, response, 409, "SELF_CHANGE", "Anda tidak dapat mengubah status akun sendiri.");
    const target = users.find((user) => user.id === id);
    if (!target) return fail(request, response, 404, "NOT_FOUND", "Akun tidak ditemukan.");
    target.isActive = isActive;
    return send(request, response, 200, { user: adminUser(target) });
  },

  // --- drivers (staff) ------------------------------------------------------

  "GET /api/drivers": (request, response, url) => {
    if (!guard(request, response, [["drivers", "VIEW"]], { staffOnly: true })) return 0;
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const status = url.searchParams.get("status") ?? "";
    const push = url.searchParams.get("push") ?? "";
    const matches = drivers.filter(
      (item) =>
        (!status || item.registryStatus === status) &&
        (!push || item.registryPush === push) &&
        (!q || includesText(item.fullName, q) || includesText(item.licenceNo, q)),
    );
    return page(request, response, url, matches.map(publicDriver));
  },

  "POST /api/drivers": async (request, response) => {
    if (!guard(request, response, [["drivers", "CREATE"]], { staffOnly: true })) return 0;
    const body = await readJson(request);
    const fields = {};
    for (const name of ["fullName", "licenceNo", "licenceClass"]) {
      if (!optionalText(body[name])) fields[name] = "Wajib diisi.";
    }
    if (!isDate(body.licenceValidUntil)) fields.licenceValidUntil = "Masa berlaku SIM harus tanggal (YYYY-MM-DD).";
    if (Object.keys(fields).length > 0) return invalid(request, response, fields);
    const licenceNo = body.licenceNo.trim().toUpperCase();
    if (drivers.some((item) => item.licenceNo === licenceNo)) {
      return fail(request, response, 409, "DUPLICATE", `Nomor SIM ${licenceNo} sudah terdaftar.`);
    }
    const created = {
      id: `d-${nextDriverId++}`,
      fullName: body.fullName.trim(),
      licenceNo,
      licenceClass: body.licenceClass.trim(),
      licenceValidUntil: body.licenceValidUntil,
      phone: optionalText(body.phone),
      registryStatus: "UNKNOWN",
      registrySyncedAt: null,
      // Queued: the next VCF sync sends it.
      registryPush: "PENDING",
      registryPushError: null,
      isActive: true,
    };
    drivers.unshift(created);
    return send(request, response, 201, { driver: publicDriver(created) });
  },

  "POST /api/admin/sync/vcf": async (request, response) => {
    if (!guard(request, response, [["drivers", "EDIT"]], { staffOnly: true })) return 0;
    if (VCF_MODE === "off") return fail(request, response, 503, "NOT_CONFIGURED", "VCF belum diatur di server.");
    if (vcfRunning) return fail(request, response, 409, "SYNC_RUNNING", "Sinkronisasi master supir sedang berjalan.");
    vcfRunning = true;
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, SYNC_MS));
    vcfRunning = false;
    if (VCF_MODE === "fail") return fail(request, response, 502, "SYNC_FAILED", "Sinkronisasi master supir gagal.");
    const now = new Date().toISOString();
    // Drivers entered here are sent first; one made-up driver is always refused.
    let pushed = 0;
    let pushFailed = 0;
    for (const item of drivers) {
      if (item.registryPush !== "PENDING" && item.registryPush !== "FAILED") continue;
      if (item.rejectsPush) {
        item.registryPush = "FAILED";
        pushFailed += 1;
      } else {
        item.registryPush = "SENT";
        item.registryPushError = null;
        pushed += 1;
      }
    }
    // The registry "knows" every driver it accepted, so UNKNOWN rows visibly change.
    for (const item of drivers) {
      if (item.registryStatus === "UNKNOWN" && item.registryPush !== "FAILED") item.registryStatus = "NORMAL";
      if (item.registryPush !== "FAILED") item.registrySyncedAt = now;
    }
    const transporters = Object.values(partners).filter((partner) => partnerRole(partner) === "transporter").length;
    const result = { drivers: drivers.length, transporters };
    for (const entity of ["transporters", "drivers"]) {
      syncRuns.unshift({
        id: nextRunId++,
        entity,
        status: "SUCCESS",
        startedAt: new Date(started).toISOString(),
        finishedAt: now,
        rowsUpserted: result[entity],
        error: null,
      });
    }
    return send(request, response, 200, { ...result, skipped: 0, durationMs: Date.now() - started, pushed, pushFailed });
  },

  // --- vehicles -------------------------------------------------------------

  "GET /api/vehicle-types": (request, response) => {
    if (!guard(request, response, [["vehicles", "VIEW"], ["registrations", "VIEW"]])) return 0;
    return send(request, response, 200, { items: vehicleTypes });
  },

  "GET /api/vehicles": (request, response, url) => {
    const user = guard(request, response, [["vehicles", "VIEW"]]);
    if (!user) return 0;
    const q = plateKey(url.searchParams.get("q"));
    const matches = vehicles.filter(
      // A partner account only sees the vehicles of its own company.
      (item) => (user.kind !== "PARTNER" || item.owner?.id === user.partner.id) && (!q || item.plateNo.includes(q)),
    );
    return page(request, response, url, matches.map(publicVehicle));
  },

  "POST /api/vehicles": async (request, response) => {
    if (!guard(request, response, [["vehicles", "CREATE"]], { staffOnly: true })) return 0;
    const created = { id: `v-${nextVehicleId++}`, isActive: true, verified: true };
    const problem = applyVehicle(created, { ...EMPTY_VEHICLE_BODY, ...(await readJson(request)) }, true);
    if (problem) return send(request, response, problem.status, problem.body);
    vehicles.unshift(created);
    return send(request, response, 201, { vehicle: publicVehicle(created) });
  },

  "PATCH /api/vehicles/:id": async (request, response, url, id) => {
    if (!guard(request, response, [["vehicles", "EDIT"]], { staffOnly: true })) return 0;
    const target = vehicles.find((item) => item.id === id);
    if (!target) return fail(request, response, 404, "NOT_FOUND", "Kendaraan tidak ditemukan.");
    const problem = applyVehicle(target, await readJson(request), false);
    if (problem) return send(request, response, problem.status, problem.body);
    return send(request, response, 200, { vehicle: publicVehicle(target) });
  },

  // --- partners and destinations ---------------------------------------------

  "GET /api/partners": (request, response, url) => {
    if (!guard(request, response, [], { staffOnly: true })) return 0;
    const role = url.searchParams.get("role");
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = Object.values(partners).filter(
      (partner) => (!role || partnerRole(partner) === role) && (!q || includesText(partner.name, q)),
    );
    return page(
      request,
      response,
      url,
      matches.map((partner) => ({
        id: partner.id,
        name: partner.name,
        code: partner.id.toUpperCase(),
        isSupplier: partnerRole(partner) === "supplier",
        isCustomer: partnerRole(partner) === "customer",
        isTransporter: partnerRole(partner) === "transporter",
      })),
    );
  },

  "GET /api/destinations": (request, response, url) => {
    if (!guard(request, response, [["destinations", "VIEW"]])) return 0;
    const partnerId = url.searchParams.get("partnerId") ?? "";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = destinations.filter(
      (item) =>
        (!partnerId || item.partner?.id === partnerId) &&
        (!q || includesText(item.name, q) || includesText(item.address, q)),
    );
    return page(request, response, url, matches);
  },

  "POST /api/destinations": async (request, response) => {
    if (!guard(request, response, [["destinations", "CREATE"]])) return 0;
    const created = { id: `t-${nextDestinationId++}`, isActive: true };
    const fields = applyDestination(created, await readJson(request), true);
    if (fields) return invalid(request, response, fields);
    destinations.unshift(created);
    return send(request, response, 201, { destination: created });
  },

  "PATCH /api/destinations/:id": async (request, response, url, id) => {
    if (!guard(request, response, [["destinations", "EDIT"]])) return 0;
    const target = destinations.find((item) => item.id === id);
    if (!target) return fail(request, response, 404, "NOT_FOUND", "Tujuan tidak ditemukan.");
    const fields = applyDestination(target, await readJson(request), false);
    if (fields) return invalid(request, response, fields);
    return send(request, response, 200, { destination: target });
  },

  // --- phase 3: what the registration and DO forms read -----------------------

  "GET /api/quality-parameters": (request, response) => {
    if (!guard(request, response, [["registrations", "VIEW"]])) return 0;
    return send(request, response, 200, { items: qualityParameters });
  },

  // staff only: a partner account gets its products through its contracts and DOs
  "GET /api/products": (request, response, url) => {
    if (!guard(request, response, [["delivery_orders", "VIEW"]], { staffOnly: true })) return 0;
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    return page(
      request,
      response,
      url,
      Object.values(products)
        .filter((item) => !q || includesText(item.name, q))
        .map(({ id, name, category }) => ({ id, name, category })),
    );
  },

  // The lookups never list: one whole licence number or plate finds at most one row, a transporter only by name.
  "GET /api/lookup/driver": (request, response, url) => {
    if (!guard(request, response, [["registrations", "CREATE"]])) return 0;
    const key = plateKey(url.searchParams.get("licenceNo")).replace(/[^A-Z0-9]/g, "");
    const row = key.length >= 3 ? drivers.find((item) => item.licenceNo === key) : null;
    if (!row) return send(request, response, 200, { driver: null });
    const { id, fullName, licenceNo, licenceClass, licenceValidUntil, registryStatus, isActive } = row;
    return send(request, response, 200, {
      driver: { id, fullName, licenceNo, licenceClass, licenceValidUntil, registryStatus, licenceExpired: licenceValidUntil < today(), blocked: row.blocked === true, isActive },
    });
  },

  "GET /api/lookup/vehicle": (request, response, url) => {
    if (!guard(request, response, [["registrations", "CREATE"]])) return 0;
    const key = plateKey(url.searchParams.get("plate")).replace(/[^A-Z0-9]/g, "");
    const row = key.length >= 3 ? vehicles.find((item) => item.plateNo === key) : null;
    if (!row) return send(request, response, 200, { vehicle: null });
    return send(request, response, 200, {
      vehicle: {
        id: row.id,
        plateNo: row.plateNo,
        plateDisplay: row.plateDisplay,
        vehicleTypeCode: row.vehicleTypeCode,
        needsContainerNo: vehicleTypes.find((type) => type.code === row.vehicleTypeCode)?.needsContainerNo ?? false,
        capacityKg: row.capacityKg,
        tareKg: row.tareKg,
        expired: publicVehicle(row).expired,
        verified: row.verified,
        owner: ref(row.owner),
        isActive: row.isActive,
      },
    });
  },

  "GET /api/lookup/transporters": (request, response, url) => {
    if (!guard(request, response, [["registrations", "CREATE"]])) return 0;
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (q.length < 2) return send(request, response, 200, { items: [], total: 0 });
    const matches = Object.values(partners).filter((partner) => partnerRole(partner) === "transporter" && includesText(partner.name, q));
    return page(request, response, url, matches.map(ref));
  },

  // --- RFID cards -------------------------------------------------------------

  "GET /api/rfid-cards": (request, response, url) => {
    if (!guard(request, response, [["rfid_cards", "VIEW"]])) return 0;
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const status = url.searchParams.get("status") ?? "";
    const matches = rfidCards.filter(
      (card) => (!status || card.status === status) && (!q || includesText(card.uid, q) || includesText(card.label, q)),
    );
    return page(
      request,
      response,
      url,
      matches.map((card) => {
        const trip = trips.find((item) => item.id === card.tripId);
        return {
          id: card.id,
          uid: card.uid,
          label: card.label,
          status: card.status,
          note: card.note,
          trip: trip ? { id: trip.id, tripNo: trip.tripNo, plateNo: vehicleOf(trip).plateNo } : null,
        };
      }),
    );
  },

  "POST /api/rfid-cards": async (request, response) => {
    if (!guard(request, response, [["rfid_cards", "CREATE"]])) return 0;
    const body = await readJson(request);
    const uid = normalizeUid(body.uid);
    if (!/^[0-9A-F]{8,20}$/.test(uid)) return invalid(request, response, { uid: "UID kartu harus 8 sampai 20 digit heksadesimal." });
    if (rfidCards.some((card) => card.uid === uid)) return fail(request, response, 409, "DUPLICATE", `Kartu ${uid} sudah terdaftar.`);
    const card = { id: `k-${nextCardId++}`, uid, label: optionalText(body.label), status: "AVAILABLE", note: optionalText(body.note), tripId: null };
    rfidCards.unshift(card);
    return send(request, response, 201, { card: { ...card, trip: null, tripId: undefined } });
  },

  "PATCH /api/rfid-cards/:id": async (request, response, url, id) => {
    if (!guard(request, response, [["rfid_cards", "EDIT"]])) return 0;
    const card = rfidCards.find((item) => item.id === id);
    if (!card) return fail(request, response, 404, "NOT_FOUND", "Kartu tidak ditemukan.");
    const body = await readJson(request);
    if ("status" in body && body.status !== card.status) {
      if (!["AVAILABLE", "LOST", "RETIRED"].includes(body.status)) return invalid(request, response, { status: "Status hanya boleh AVAILABLE, LOST, atau RETIRED." });
      if (card.tripId) return fail(request, response, 409, "INVALID_STATE", "Kartu sedang dipakai truk. Lepas kartu dulu sebelum mengubah statusnya.");
      card.status = body.status;
    }
    if ("label" in body) card.label = optionalText(body.label);
    if ("note" in body) card.note = optionalText(body.note);
    return send(request, response, 200, { card: { ...card, trip: null, tripId: undefined } });
  },

  // --- delivery orders ----------------------------------------------------------

  "GET /api/delivery-orders": (request, response, url) => {
    const user = guard(request, response, [["delivery_orders", "VIEW"]]);
    if (!user) return 0;
    const status = url.searchParams.get("status") ?? "";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = deliveryOrders
      .filter((order) => user.kind === "INTERNAL" || (order.transporterId === user.partner.id && order.status !== "DRAFT"))
      .filter((order) => !status || order.status === status)
      .map(publicOrder)
      .filter(
        (order) =>
          !q ||
          includesText(order.doNo, q) ||
          includesText(order.contract?.contractNo, q) ||
          includesText(order.partner?.name, q) ||
          includesText(order.customerPoNo, q),
      )
      .reverse();
    return page(request, response, url, matches);
  },

  "GET /api/delivery-orders/:id": (request, response, url, id) => {
    const user = guard(request, response, [["delivery_orders", "VIEW"]]);
    if (!user) return 0;
    const order = deliveryOrders.find((item) => item.id === id);
    if (!order || (user.kind === "PARTNER" && (order.transporterId !== user.partner.id || order.status === "DRAFT"))) {
      return fail(request, response, 404, "NOT_FOUND", "DO tidak ditemukan.");
    }
    const orderTrips = trips.filter((trip) => registrationOf(trip).allocations.some((allocation) => allocation.deliveryOrderId === order.id));
    return send(request, response, 200, { deliveryOrder: publicOrder(order), trips: orderTrips.map(publicTrip) });
  },

  "POST /api/delivery-orders": async (request, response) => {
    if (!guard(request, response, [["delivery_orders", "CREATE"]], { staffOnly: true })) return 0;
    const body = await readJson(request);
    const order = {
      id: `do-${nextOrderId++}`,
      status: "DRAFT",
      truckCountBy: null,
      sentAt: null,
      acceptedAt: null,
    };
    const outcome = applyOrder(order, body, true);
    if (outcome) {
      nextOrderId -= 1;
      return reply(request, response, outcome);
    }
    deliveryOrders.push(order);
    return send(request, response, 201, { deliveryOrder: publicOrder(order) });
  },

  "PATCH /api/delivery-orders/:id": async (request, response, url, id) => {
    if (!guard(request, response, [["delivery_orders", "EDIT"]], { staffOnly: true })) return 0;
    const order = deliveryOrders.find((item) => item.id === id);
    if (!order) return fail(request, response, 404, "NOT_FOUND", "DO tidak ditemukan.");
    const body = await readJson(request);
    if (["CLOSED", "CANCELLED"].includes(order.status)) return fail(request, response, 409, "INVALID_STATE", "DO yang sudah ditutup atau dibatalkan tidak bisa diubah.");
    if (order.status !== "DRAFT") {
      const extra = Object.keys(body).filter((key) => !["deliveryUntil", "truckCount", "remark"].includes(key) && body[key] !== undefined);
      if (extra.length > 0) {
        return fail(request, response, 409, "INVALID_STATE", "Setelah DO dikirim, hanya tanggal akhir kirim, jumlah truk, dan keterangan yang boleh diubah.");
      }
    }
    const outcome = applyOrder(order, body, false);
    if (outcome) return reply(request, response, outcome);
    return send(request, response, 200, { deliveryOrder: publicOrder(order) });
  },

  "POST /api/delivery-orders/:id/send": async (request, response, url, id) => {
    if (!guard(request, response, [["delivery_orders", "EDIT"]], { staffOnly: true })) return 0;
    const order = deliveryOrders.find((item) => item.id === id);
    if (!order) return fail(request, response, 404, "NOT_FOUND", "DO tidak ditemukan.");
    const body = await readJson(request);
    if (order.status !== "DRAFT") return fail(request, response, 409, "INVALID_STATE", "Hanya DO berstatus DRAFT yang bisa dikirim.");
    const transporterId = body.transporterId ?? order.transporterId;
    if (!transporterId) return invalid(request, response, { transporterId: "Pilih transporter sebelum DO dikirim." });
    if (partnerRole(findPartner(transporterId) ?? { id: "p-0" }) !== "transporter") {
      return invalid(request, response, { transporterId: "Transporter harus partner transporter." });
    }
    Object.assign(order, { transporterId, status: "SENT", sentAt: nowIso() });
    return send(request, response, 200, { deliveryOrder: publicOrder(order) });
  },

  // the transporter accepts a DO sent to its own company; staff accept any
  "POST /api/delivery-orders/:id/accept": async (request, response, url, id) => {
    const user = guard(request, response, [["delivery_orders", "EDIT"]]);
    if (!user) return 0;
    const order = deliveryOrders.find((item) => item.id === id);
    const visible = order && (user.kind === "INTERNAL" || (order.transporterId === user.partner.id && order.status !== "DRAFT"));
    if (!visible) return fail(request, response, 404, "NOT_FOUND", "DO tidak ditemukan.");
    if (order.status !== "SENT") return fail(request, response, 409, "INVALID_STATE", "Hanya DO berstatus SENT yang bisa diterima.");
    const { truckCount } = await readJson(request);
    if (truckCount !== undefined && truckCount !== null) {
      if (!Number.isInteger(truckCount) || truckCount < 1 || truckCount > 500) return invalid(request, response, { truckCount: "Jumlah truk harus antara 1 dan 500." });
      if (order.truckCount === null) Object.assign(order, { truckCount, truckCountBy: "TRANSPORTER" });
    }
    Object.assign(order, { status: "ACCEPTED", acceptedAt: nowIso() });
    return send(request, response, 200, { deliveryOrder: publicOrder(order) });
  },

  "POST /api/delivery-orders/:id/close": (request, response, url, id) => {
    if (!guard(request, response, [["delivery_orders", "EDIT"]], { staffOnly: true })) return 0;
    const order = deliveryOrders.find((item) => item.id === id);
    if (!order) return fail(request, response, 404, "NOT_FOUND", "DO tidak ditemukan.");
    if (order.status !== "ACCEPTED") return fail(request, response, 409, "INVALID_STATE", "Hanya DO berstatus ACCEPTED yang bisa ditutup.");
    order.status = "CLOSED";
    return send(request, response, 200, { deliveryOrder: publicOrder(order) });
  },

  "POST /api/delivery-orders/:id/cancel": async (request, response, url, id) => {
    if (!guard(request, response, [["delivery_orders", "EDIT"]], { staffOnly: true })) return 0;
    const order = deliveryOrders.find((item) => item.id === id);
    if (!order) return fail(request, response, 404, "NOT_FOUND", "DO tidak ditemukan.");
    const { reason } = await readJson(request);
    if (!optionalText(reason)) return invalid(request, response, { reason: "Alasan wajib diisi." });
    if (!["DRAFT", "SENT", "ACCEPTED"].includes(order.status)) return fail(request, response, 409, "INVALID_STATE", "DO ini sudah ditutup atau dibatalkan.");
    const orderTrips = trips.filter((trip) => registrationOf(trip).allocations.some((allocation) => allocation.deliveryOrderId === order.id));
    if (orderTrips.some((trip) => ARRIVED.includes(trip.status))) {
      return fail(request, response, 409, "INVALID_STATE", "DO tidak bisa dibatalkan: sudah ada truk yang check-in.");
    }
    for (const trip of orderTrips.filter((item) => ["DRAFT", "READY", "ISSUED", "EXPIRED"].includes(refreshTrip(item).status))) {
      Object.assign(trip, { status: "CANCELLED", cancelReason: reason.trim() });
      revokeSpj(trip);
    }
    Object.assign(order, { status: "CANCELLED", cancelReason: reason.trim() });
    return send(request, response, 200, { deliveryOrder: publicOrder(order) });
  },

  // --- registrations ------------------------------------------------------------

  "GET /api/registrations": (request, response, url) => {
    const user = guard(request, response, [["registrations", "VIEW"]]);
    if (!user) return 0;
    const direction = url.searchParams.get("direction") ?? "";
    const status = url.searchParams.get("status") ?? "";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = registrations
      .filter((registration) => canReach(user, registration))
      .filter((registration) => (!direction || registration.direction === direction) && (!status || registration.status === status))
      .filter((registration) => {
        if (!q) return true;
        const shown = publicRegistration(registration);
        return (
          includesText(shown.regNo, q) ||
          includesText(shown.partner?.name, q) ||
          shown.trips.some((trip) => plateKey(trip.vehicle?.plateDisplay).includes(plateKey(q))) ||
          shown.allocations.some((allocation) => includesText(allocation.contractNo, q) || includesText(allocation.doNo, q))
        );
      })
      .map((registration) => publicRegistration(registration, false))
      .reverse();
    return page(request, response, url, matches);
  },

  "GET /api/registrations/:id": (request, response, url, id) => {
    const user = guard(request, response, [["registrations", "VIEW"]]);
    if (!user) return 0;
    const registration = registrations.find((item) => item.id === id);
    if (!registration || !canReach(user, registration)) return fail(request, response, 404, "NOT_FOUND", "Registrasi tidak ditemukan.");
    return send(request, response, 200, { registration: publicRegistration(registration) });
  },

  "POST /api/registrations": async (request, response) => {
    const user = guard(request, response, [["registrations", "CREATE"]]);
    if (!user) return 0;
    const { plan, problem: refused } = planRegistration(user, await readJson(request));
    if (refused) return reply(request, response, refused);
    const registration = {
      id: `r-${nextRegistrationId++}`,
      regNo: regNumber(),
      status: "DRAFT",
      createdVia: user.kind === "INTERNAL" ? "OPERATOR" : "PORTAL",
      createdBy: { id: user.id, fullName: user.fullName },
      createdAt: nowIso(),
      // whose registration it is: the supplier of an incoming one, the transporter of an outgoing one
      ownerPartnerId: plan.direction === "IN" ? plan.partner.id : plan.transporterId,
      submittedAt: null,
      reviewedAt: null,
      reviewNote: null,
    };
    registrations.push(registration);
    writeRegistration(registration, plan, user);
    if (plan.submit) submitRegistration(registration);
    else registration.findings = computeFindings(registration);
    return send(request, response, 201, { registration: publicRegistration(registration) });
  },

  "PUT /api/registrations/:id": async (request, response, url, id) => {
    const user = guard(request, response, [["registrations", "CREATE"]]);
    if (!user) return 0;
    const registration = registrations.find((item) => item.id === id);
    if (!registration || !canReach(user, registration)) return fail(request, response, 404, "NOT_FOUND", "Registrasi tidak ditemukan.");
    const body = await readJson(request);
    if (registration.status !== "DRAFT") return fail(request, response, 409, "INVALID_STATE", "Hanya registrasi berstatus DRAFT yang bisa diubah.");
    if (body.direction !== registration.direction) return invalid(request, response, { direction: "Arah registrasi tidak bisa diubah." });
    const { plan, problem: refused } = planRegistration(user, body);
    if (refused) return reply(request, response, refused);
    writeRegistration(registration, plan, user);
    if (plan.submit) submitRegistration(registration);
    else registration.findings = computeFindings(registration);
    return send(request, response, 200, { registration: publicRegistration(registration) });
  },

  "POST /api/registrations/:id/submit": (request, response, url, id) => {
    const user = guard(request, response, [["registrations", "CREATE"]]);
    if (!user) return 0;
    const registration = registrations.find((item) => item.id === id);
    if (!registration || !canReach(user, registration)) return fail(request, response, 404, "NOT_FOUND", "Registrasi tidak ditemukan.");
    if (registration.status !== "DRAFT") return fail(request, response, 409, "INVALID_STATE", "Hanya registrasi berstatus DRAFT yang bisa dikirim.");
    if (registration.direction === "OUT" && (registration.closeCargo === null || registration.flexiBag === null)) {
      return invalid(request, response, { closeCargo: "Close cargo wajib dijawab sebelum dikirim.", flexiBag: "Flexi bag wajib dijawab sebelum dikirim." });
    }
    submitRegistration(registration);
    return send(request, response, 200, { registration: publicRegistration(registration) });
  },

  // a partner account never approves or rejects, whatever its level
  "POST /api/registrations/:id/approve": async (request, response, url, id) => {
    const user = guard(request, response, [["registrations", "EDIT"]], { staffOnly: true });
    if (!user) return 0;
    const registration = registrations.find((item) => item.id === id);
    if (!registration) return fail(request, response, 404, "NOT_FOUND", "Registrasi tidak ditemukan.");
    if (registration.status !== "SUBMITTED") return fail(request, response, 409, "INVALID_STATE", "Hanya registrasi yang menunggu tinjauan yang bisa disetujui.");
    const { note } = await readJson(request);
    approveRegistration(registration, user, optionalText(note));
    return send(request, response, 200, { registration: publicRegistration(registration) });
  },

  "POST /api/registrations/:id/reject": async (request, response, url, id) => {
    if (!guard(request, response, [["registrations", "EDIT"]], { staffOnly: true })) return 0;
    const registration = registrations.find((item) => item.id === id);
    if (!registration) return fail(request, response, 404, "NOT_FOUND", "Registrasi tidak ditemukan.");
    const { note } = await readJson(request);
    if (!optionalText(note)) return invalid(request, response, { note: "Alasan penolakan wajib diisi." });
    if (registration.status !== "SUBMITTED") return fail(request, response, 409, "INVALID_STATE", "Hanya registrasi yang menunggu tinjauan yang bisa ditolak.");
    Object.assign(registration, { status: "REJECTED", reviewedAt: nowIso(), reviewNote: note.trim() });
    for (const trip of tripsOf(registration)) {
      Object.assign(trip, { status: "CANCELLED", cancelReason: note.trim() });
      revokeSpj(trip);
    }
    return send(request, response, 200, { registration: publicRegistration(registration) });
  },

  "POST /api/registrations/:id/cancel": async (request, response, url, id) => {
    const user = guard(request, response, [["registrations", "CREATE"]]);
    if (!user) return 0;
    const registration = registrations.find((item) => item.id === id);
    if (!registration || !canReach(user, registration)) return fail(request, response, 404, "NOT_FOUND", "Registrasi tidak ditemukan.");
    // a partner reaches only its own registrations; staff with CREATE only the ones they made
    if (user.kind === "INTERNAL" && registration.createdBy.id !== user.id && !can(user, "registrations", "EDIT")) {
      return fail(request, response, 403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
    }
    const { reason } = await readJson(request);
    if (!optionalText(reason)) return invalid(request, response, { reason: "Alasan wajib diisi." });
    if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(registration.status)) {
      return fail(request, response, 409, "INVALID_STATE", "Registrasi ini sudah selesai, ditolak, atau dibatalkan.");
    }
    if (tripsOf(registration).some((trip) => ARRIVED.includes(trip.status))) {
      return fail(request, response, 409, "INVALID_STATE", "Registrasi tidak bisa dibatalkan: sudah ada truk yang check-in.");
    }
    for (const trip of tripsOf(registration).filter((item) => item.status !== "CANCELLED")) {
      Object.assign(trip, { status: "CANCELLED", cancelReason: reason.trim() });
      revokeSpj(trip);
    }
    registration.status = "CANCELLED";
    return send(request, response, 200, { registration: publicRegistration(registration) });
  },

  // --- trips and SPJ --------------------------------------------------------------

  // staff only: the list is not limited to a company
  "GET /api/trips": (request, response, url) => {
    if (!guard(request, response, [["gate", "VIEW"], ["registrations", "VIEW"]], { staffOnly: true })) return 0;
    const statuses = (url.searchParams.get("status") ?? "").split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
    const date = url.searchParams.get("date") ?? "";
    const q = plateKey(url.searchParams.get("q"));
    const matches = trips
      .map(refreshTrip)
      .filter((trip) => statuses.length === 0 || statuses.includes(trip.status))
      // apps/api trips/routes.ts: the planned day of the trip (or its registration), or the day it checked in
      .filter(
        (trip) =>
          !date ||
          (trip.plannedArrival ?? registrationOf(trip).plannedDate) === date ||
          (trip.checkedInAt !== null && plantDate(new Date(trip.checkedInAt)).iso === date),
      )
      .map(publicTrip)
      .filter(
        (trip) =>
          !q ||
          plateKey(trip.vehicle?.plateDisplay).includes(q) ||
          plateKey(trip.spj?.spjNo).includes(q) ||
          plateKey(trip.tripNo).includes(q),
      )
      .sort((a, b) => String(a.plannedArrival ?? "").localeCompare(String(b.plannedArrival ?? "")));
    return page(request, response, url, matches);
  },

  // the SPJ belongs to the registration: whoever may see the registration may print it
  "GET /api/trips/:id/spj": (request, response, url, id) => {
    const user = guard(request, response, [["registrations", "VIEW"]]);
    if (!user) return 0;
    const trip = trips.find((item) => item.id === id);
    const registration = trip ? registrationOf(trip) : null;
    if (!trip || !trip.spj || !canReach(user, registration)) return fail(request, response, 404, "NOT_FOUND", "SPJ tidak ditemukan.");
    const driverRow = driverOf(trip);
    const vehicleRow = vehicleOf(trip);
    const lines = registration.allocations.map((allocation) => {
      const contractRow = contracts.find((item) => item.id === allocation.contractId) ?? null;
      const order = deliveryOrders.find((item) => item.id === allocation.deliveryOrderId) ?? null;
      const destinationRow = order ? destinations.find((item) => item.id === order.destinationId) : null;
      const source = contractRow ?? order;
      return {
        contractNo: contractRow?.contractNo ?? contracts.find((item) => item.id === order?.contractId)?.contractNo ?? "-",
        doNo: order?.doNo ?? null,
        product: { id: source.product.id, name: source.product.name },
        qtyPlanned: trip.allocations[allocation.seq - 1]?.qtyPlanned ?? null,
        uom: source.uom ?? "Kg",
        partner: ref(source.partner),
        destination: destinationRow
          ? (({ id: destinationId, name, address, district, regency, province }) => ({ id: destinationId, name, address, district, regency, province }))(destinationRow)
          : null,
      };
    });
    return send(request, response, 200, {
      spj: {
        spjNo: trip.spj.spjNo,
        barcodeToken: trip.spj.barcodeToken,
        issuedAt: trip.spj.issuedAt,
        validUntil: trip.spj.validUntil,
        printCount: trip.spj.printCount,
        site: SITE,
        direction: registration.direction,
        driver: { fullName: driverRow?.fullName ?? null, licenceNo: driverRow?.licenceNo ?? null },
        vehicle: { plateDisplay: vehicleRow?.plateDisplay ?? null, vehicleType: vehicleTypes.find((type) => type.code === vehicleRow?.vehicleTypeCode)?.name ?? null },
        containerNo: trip.containerNo,
        transporter: ref(findPartner(registration.transporterId)),
        lines,
      },
    });
  },

  "POST /api/trips/:id/spj/printed": (request, response, url, id) => {
    const user = guard(request, response, [["registrations", "VIEW"]]);
    if (!user) return 0;
    const trip = trips.find((item) => item.id === id);
    if (!trip || !trip.spj || !canReach(user, registrationOf(trip))) return fail(request, response, 404, "NOT_FOUND", "SPJ tidak ditemukan.");
    trip.spj.printCount += 1;
    return send(request, response, 200, { printCount: trip.spj.printCount });
  },

  "POST /api/trips/:id/spj/reissue": async (request, response, url, id) => {
    const user = guard(request, response, [["gate", "EDIT"]]);
    if (!user) return 0;
    const { reason } = await readJson(request);
    if (!optionalText(reason)) return invalid(request, response, { reason: "Alasan wajib diisi." });
    const trip = trips.find((item) => item.id === id);
    if (!trip || !canReach(user, registrationOf(trip))) return fail(request, response, 404, "NOT_FOUND", "Trip tidak ditemukan.");
    if (!["ISSUED", "EXPIRED"].includes(refreshTrip(trip).status) || registrationOf(trip).status !== "APPROVED") {
      return fail(request, response, 409, "INVALID_STATE", "SPJ hanya bisa diterbitkan ulang untuk truk yang belum check-in pada registrasi yang disetujui.");
    }
    revokeSpj(trip);
    issueSpj(trip);
    return send(request, response, 200, { trip: publicTrip(trip) });
  },

  // the owner (registrations CREATE) cancels before check-in; the desk (gate EDIT) also after check-in
  "POST /api/trips/:id/cancel": async (request, response, url, id) => {
    const user = guard(request, response, [["gate", "EDIT"], ["registrations", "CREATE"]]);
    if (!user) return 0;
    const isDesk = user.kind === "INTERNAL" && can(user, "gate", "EDIT");
    const { reason } = await readJson(request);
    if (!optionalText(reason)) return invalid(request, response, { reason: "Alasan wajib diisi." });
    const trip = trips.find((item) => item.id === id);
    if (!trip || !canReach(user, registrationOf(trip))) return fail(request, response, 404, "NOT_FOUND", "Trip tidak ditemukan.");
    if (!isDesk && user.kind === "INTERNAL" && registrationOf(trip).createdBy.id !== user.id) {
      return fail(request, response, 403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
    }
    const allowed = isDesk ? ["DRAFT", "READY", "ISSUED", "EXPIRED", "CHECKED_IN"] : ["DRAFT", "READY", "ISSUED", "EXPIRED"];
    if (!allowed.includes(refreshTrip(trip).status)) {
      return fail(
        request,
        response,
        409,
        "INVALID_STATE",
        isDesk ? "Trip ini sudah ditimbang, selesai, atau dibatalkan." : "Trip yang sudah check-in hanya bisa dibatalkan petugas.",
      );
    }
    Object.assign(trip, { status: "CANCELLED", cancelReason: reason.trim(), currentStep: null });
    revokeSpj(trip);
    releaseCard(trip, "CANCELLED");
    return send(request, response, 200, { trip: publicTrip(trip) });
  },

  // --- registration post ------------------------------------------------------------

  "GET /api/gate/spj/:id": (request, response, url, token) => {
    if (!guard(request, response, [["gate", "VIEW"]])) return 0;
    const trip = findByToken(token);
    if (!trip) return fail(request, response, 404, "SPJ_NOT_FOUND", "SPJ dengan kode ini tidak ditemukan.");
    return send(request, response, 200, { trip: publicTrip(trips.find((item) => item.id === trip.id)), checks: gateChecks(trip) });
  },

  "POST /api/gate/check-in": async (request, response) => {
    if (!guard(request, response, [["gate", "CREATE"]])) return 0;
    const body = await readJson(request);
    const uid = normalizeUid(body.cardUid);
    if (!/^[0-9A-F]{8,20}$/.test(uid)) return invalid(request, response, { cardUid: "UID kartu harus 8 sampai 20 digit heksadesimal." });
    const found = findByToken(body.token);
    if (!found) return fail(request, response, 404, "SPJ_NOT_FOUND", "SPJ dengan kode ini tidak ditemukan.");
    const trip = trips.find((item) => item.id === found.id);
    const refuse = (code) => fail(request, response, 409, code, GATE_MESSAGES[code]);
    if (found.revoked) return refuse("SPJ_REVOKED");
    if (ARRIVED.includes(trip.status)) return refuse("ALREADY_CHECKED_IN");
    if (trip.status === "EXPIRED") return refuse("SPJ_EXPIRED");
    if (trip.status !== "ISSUED") return fail(request, response, 409, "INVALID_STATE", "Truk ini belum siap check-in.");
    const driverRow = driverOf(trip);
    const verdict = registryVerdict(driverRow);
    if (verdict?.level === "BLOCK") return fail(request, response, 409, verdict.code, verdict.message);
    if (driverRow.blocked) return fail(request, response, 409, "DRIVER_BLOCKED", `Supir ${driverRow.fullName} sedang diblokir.`);
    const card = rfidCards.find((item) => item.uid === uid) ?? null;
    const refused = cardProblem(card);
    if (refused) return reply(request, response, refused);
    if (insideElsewhere(trip, "vehicleId")) return refuse("VEHICLE_INSIDE");
    if (insideElsewhere(trip, "driverId")) return refuse("DRIVER_INSIDE");
    const now = new Date();
    const { year, month, day, iso } = plantDate(now);
    bindCard(trip, card);
    const steps = flowSteps[registrationOf(trip).flowCode] ?? ["CHECK_IN"];
    Object.assign(trip, {
      status: "CHECKED_IN",
      checkedInAt: now.toISOString(),
      tripNo: `${year}${month}${day}-${String(nextNumber(`TRIP|${iso}`)).padStart(4, "0")}`,
      steps: steps.map((code, index) => ({ code, status: index === 0 ? "DONE" : index === 1 ? "READY" : "PENDING" })),
      currentStep: steps[1] ?? null,
    });
    return send(request, response, 200, { trip: publicTrip(trip) });
  },

  "POST /api/gate/replace-card": async (request, response) => {
    if (!guard(request, response, [["gate", "EDIT"]])) return 0;
    const body = await readJson(request);
    const uid = normalizeUid(body.cardUid);
    const fields = {};
    if (!/^[0-9A-F]{8,20}$/.test(uid)) fields.cardUid = "UID kartu harus 8 sampai 20 digit heksadesimal.";
    if (!["REPLACED", "LOST"].includes(body.reason)) fields.reason = "Alasan harus REPLACED atau LOST.";
    if (Object.keys(fields).length > 0) return invalid(request, response, fields);
    const trip = trips.find((item) => item.id === body.tripId);
    if (!trip) return fail(request, response, 404, "NOT_FOUND", "Trip tidak ditemukan.");
    if (!INSIDE.includes(trip.status) || !rfidCards.some((item) => item.tripId === trip.id)) {
      return fail(request, response, 409, "INVALID_STATE", "Kartu hanya bisa diganti untuk truk yang sedang di dalam dengan kartu terikat.");
    }
    const card = rfidCards.find((item) => item.uid === uid) ?? null;
    const refused = cardProblem(card);
    if (refused) return reply(request, response, refused);
    releaseCard(trip, body.reason);
    bindCard(trip, card);
    return send(request, response, 200, { trip: publicTrip(trip) });
  },

  "POST /__mock/expire-access-tokens": (request, response) => {
    accessTokens.clear();
    return send(request, response, 204);
  },

  "POST /__mock/end-sessions": (request, response) => {
    accessTokens.clear();
    sessions.clear();
    return send(request, response, 204);
  },

  "GET /__mock/stats": (request, response) => send(request, response, 200, { requests: stats }),
};

/** Routes written with ":id" match one path segment in that place. */
const idRoutes = Object.entries(routes)
  .filter(([key]) => key.includes(":id"))
  .map(([key, handler]) => {
    const [method, path] = key.split(" ");
    return { key, method, handler, pattern: new RegExp(`^${path.replace(":id", "([^/]+)")}$`) };
  });

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }
  let key = `${request.method} ${url.pathname}`;
  let handler = routes[key];
  let id;
  if (!handler) {
    const match = idRoutes.find((route) => route.method === request.method && route.pattern.test(url.pathname));
    if (match) {
      key = match.key;
      handler = match.handler;
      id = decodeURIComponent(match.pattern.exec(url.pathname)[1]);
    }
  }
  let status;
  try {
    status = handler
      ? await handler(request, response, url, id)
      : fail(request, response, 404, "NOT_FOUND", "No such route in the mock");
  } catch (error) {
    console.error(error);
    status = response.headersSent ? 500 : fail(request, response, 500, "INTERNAL_ERROR", "The mock failed");
  }
  if (!url.pathname.startsWith("/__mock/")) stats[key] = (stats[key] ?? 0) + 1;
  // The path is logged without its query, which can carry a ticket.
  console.log(`${request.method} ${url.pathname} ${status || response.statusCode}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Mock API on http://${HOST}:${PORT} (web origin ${WEB_ORIGIN})`);
  console.log("Partner sign-in, password contoh-123: pks.contoh.a, transporter.contoh");
  console.log(`Staff sign-in: open http://${HOST}:${PORT}/api/auth/sso/start?as=admin.contoh`);
  console.log("  other staff: super.contoh (every module), pos.contoh (registration post), staf.baru (no access yet)");
  console.log("Local staff sign-in, password contoh-123: petugas.lokal (every module)");
});
