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
// Helpers that the real API does not have (used by dev/smoke.mjs):
//   GET  /api/auth/sso/start?as=<username>&to=root|callback   plays the portal: redirects back with a ticket
//   POST /__mock/expire-access-tokens                         makes every access token invalid
//   POST /__mock/end-sessions                                 also drops every refresh session
//   GET  /__mock/stats                                        request counts per route

import { randomBytes } from "node:crypto";
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
const SYNC_ROLES = ["SUPER_ADMIN", "LOGISTICS_ADMIN"];
const MASTER_WRITE_ROLES = [...SYNC_ROLES, "REGISTRATION_OPERATOR"];
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

// Staff accounts sign in through the portal only, so they carry no password.
// The partner passwords are fixtures for this mock, not credentials of anything.
const users = [
  { id: "u-1", kind: "INTERNAL", username: "admin.contoh", fullName: "Admin Contoh", roles: ["LOGISTICS_ADMIN"], partner: null },
  { id: "u-2", kind: "INTERNAL", username: "pos.contoh", fullName: "Petugas Pos Contoh", roles: ["REGISTRATION_OPERATOR"], partner: null },
  { id: "u-3", kind: "INTERNAL", username: "staf.baru", fullName: "Staf Baru Contoh", roles: [], partner: null },
  { id: "u-4", kind: "PARTNER", username: "pks.contoh.a", fullName: "Admin PKS Contoh A", roles: ["PARTNER_SUPPLIER"], partner: partners.pksA, password: "contoh-123" },
  { id: "u-5", kind: "PARTNER", username: "transporter.contoh", fullName: "Admin Transporter Contoh A", roles: ["PARTNER_TRANSPORTER"], partner: partners.transporterA, password: "contoh-123" },
  { id: "u-6", kind: "INTERNAL", username: "super.contoh", fullName: "Admin Sistem Contoh", roles: ["SUPER_ADMIN"], partner: null },
];
users.forEach((user, index) => {
  user.employeeNo = user.kind === "INTERNAL" ? `EMP-CONTOH-${String(index + 1).padStart(2, "0")}` : null;
  user.isActive = true;
  user.lastLoginAt = null;
});

const roleDefinitions = [
  ["SUPER_ADMIN", "System admin", "INTERNAL"],
  ["LOGISTICS_ADMIN", "Logistics admin", "INTERNAL"],
  ["REGISTRATION_OPERATOR", "Registration post", "INTERNAL"],
  ["LOGISTICS_SUPERVISOR", "Logistics supervisor", "INTERNAL"],
  ["QC_OPERATOR", "QC", "INTERNAL"],
  ["QC_SUPERVISOR", "QC supervisor", "INTERNAL"],
  ["SECURITY", "Security", "INTERNAL"],
  ["UNLOADING_OPERATOR", "Unloading", "INTERNAL"],
  ["LOADING_OPERATOR", "Loading", "INTERNAL"],
  ["SEAL_OPERATOR", "Seal", "INTERNAL"],
  ["MANAGEMENT", "Management", "INTERNAL"],
  ["PARTNER_SUPPLIER", "Supplier", "PARTNER"],
  ["PARTNER_TRANSPORTER", "Transporter", "PARTNER"],
  ["PARTNER_CUSTOMER", "Customer", "PARTNER"],
].map(([code, name, scope]) => ({ code, name, scope }));

partners.transporterB = { id: "p-302", name: "Transporter Contoh B" };
partners.customerC = { id: "p-203", name: "Customer Contoh C" };

/** The id prefix says what a made-up partner is: p-1 supplier, p-2 customer, p-3 transporter. */
const partnerRole = (partner) => ({ 1: "supplier", 2: "customer", 3: "transporter" })[partner.id[2]];

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
  const { id, kind, username, fullName, roles, partner } = user;
  return { id, kind, username, fullName, roles, partner };
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

/** Like authenticate, and also refuses a staff account that has no role. */
function authorize(request, response) {
  const user = authenticate(request, response);
  if (!user) return null;
  if (user.kind === "INTERNAL" && user.roles.length === 0) {
    fail(request, response, 403, "NO_ROLE", "The account has no role yet");
    return null;
  }
  return user;
}

/** Answers 403 unless the signed-in account is staff with a role. */
function authorizeStaff(request, response) {
  const user = authorize(request, response);
  if (!user) return null;
  if (user.kind !== "INTERNAL") {
    fail(request, response, 403, "FORBIDDEN", "Staff only");
    return null;
  }
  return user;
}

/** Answers 403 unless the account holds one of the roles. */
function authorizeRoles(request, response, roles) {
  const user = authorize(request, response);
  if (!user) return null;
  if (!user.roles.some((role) => roles.includes(role))) {
    fail(request, response, 403, "FORBIDDEN", "This role may not do that");
    return null;
  }
  return user;
}

const invalid = (request, response, fields) =>
  send(request, response, 400, { error: { code: "VALIDATION", message: "Invalid request body", fields } });

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
  const { id, kind, username, fullName, employeeNo, partner, roles, isActive, lastLoginAt } = user;
  return { id, kind, username, fullName, employeeNo, partner, roles, isActive, lastLoginAt };
}

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
    const user = authorize(request, response);
    if (!user) return 0;
    const direction = url.searchParams.get("direction");
    if (direction !== "IN" && direction !== "OUT") {
      return fail(request, response, 400, "VALIDATION_ERROR", "direction must be IN or OUT");
    }
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
    const user = authorize(request, response);
    if (!user) return 0;
    if (!user.roles.some((role) => SYNC_ROLES.includes(role))) {
      return fail(request, response, 403, "FORBIDDEN", "This role may not start a sync");
    }
    if (!ODOO_CONFIGURED) return fail(request, response, 503, "NOT_CONFIGURED", "Odoo is not configured");
    if (syncRunning) return fail(request, response, 409, "SYNC_RUNNING", "A sync is already running");

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
    const user = authorize(request, response);
    if (!user) return 0;
    if (user.kind !== "INTERNAL") return fail(request, response, 403, "FORBIDDEN", "Staff only");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    return send(request, response, 200, { items: syncRuns.slice(0, limit) });
  },

  // --- users (system admin only) --------------------------------------------

  "GET /api/admin/users": (request, response, url) => {
    if (!authorizeRoles(request, response, ["SUPER_ADMIN"])) return 0;
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = users.filter((user) => !q || includesText(user.fullName, q) || includesText(user.username, q));
    return page(request, response, url, matches.map(adminUser));
  },

  "GET /api/admin/roles": (request, response) => {
    if (!authorizeRoles(request, response, ["SUPER_ADMIN"])) return 0;
    return send(request, response, 200, { items: roleDefinitions });
  },

  "PUT /api/admin/users/:id/roles": async (request, response, url, id) => {
    const admin = authorizeRoles(request, response, ["SUPER_ADMIN"]);
    if (!admin) return 0;
    const target = users.find((user) => user.id === id);
    if (!target) return fail(request, response, 404, "NOT_FOUND", "No such user");
    const { roles } = await readJson(request);
    const allowed = roleDefinitions.filter((role) => role.scope === target.kind).map((role) => role.code);
    if (!Array.isArray(roles) || roles.some((role) => !allowed.includes(role))) {
      return invalid(request, response, { roles: "Unknown role, or a role of the other account kind" });
    }
    const otherAdmins = users.some((user) => user !== target && user.isActive && user.roles.includes("SUPER_ADMIN"));
    if (target === admin && !roles.includes("SUPER_ADMIN") && !otherAdmins) {
      return fail(request, response, 409, "LAST_ADMIN_SELF", "The last system admin cannot drop that role");
    }
    target.roles = [...new Set(roles)];
    return send(request, response, 200, { user: adminUser(target) });
  },

  "PATCH /api/admin/users/:id": async (request, response, url, id) => {
    const admin = authorizeRoles(request, response, ["SUPER_ADMIN"]);
    if (!admin) return 0;
    const target = users.find((user) => user.id === id);
    if (!target) return fail(request, response, 404, "NOT_FOUND", "No such user");
    const { isActive } = await readJson(request);
    if (typeof isActive !== "boolean") return invalid(request, response, { isActive: "Must be true or false" });
    if (target === admin) return fail(request, response, 409, "SELF_CHANGE", "You cannot change your own account");
    target.isActive = isActive;
    return send(request, response, 200, { user: adminUser(target) });
  },

  // --- drivers (staff) ------------------------------------------------------

  "GET /api/drivers": (request, response, url) => {
    if (!authorizeStaff(request, response)) return 0;
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
    if (!authorizeRoles(request, response, MASTER_WRITE_ROLES)) return 0;
    const body = await readJson(request);
    const fields = {};
    for (const name of ["fullName", "licenceNo", "licenceClass"]) {
      if (!optionalText(body[name])) fields[name] = "Required";
    }
    if (!isDate(body.licenceValidUntil)) fields.licenceValidUntil = "Must be a date (YYYY-MM-DD)";
    if (Object.keys(fields).length > 0) return invalid(request, response, fields);
    const licenceNo = body.licenceNo.trim().toUpperCase();
    if (drivers.some((item) => item.licenceNo === licenceNo)) {
      return fail(request, response, 409, "DUPLICATE", "A driver with this licence number exists");
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
    if (!authorizeRoles(request, response, SYNC_ROLES)) return 0;
    if (VCF_MODE === "off") return fail(request, response, 503, "NOT_CONFIGURED", "VCF is not configured");
    if (vcfRunning) return fail(request, response, 409, "SYNC_RUNNING", "A sync is already running");
    vcfRunning = true;
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, SYNC_MS));
    vcfRunning = false;
    if (VCF_MODE === "fail") return fail(request, response, 502, "SYNC_FAILED", "The registry did not answer");
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
    if (!authorize(request, response)) return 0;
    return send(request, response, 200, { items: vehicleTypes });
  },

  "GET /api/vehicles": (request, response, url) => {
    const user = authorize(request, response);
    if (!user) return 0;
    const q = plateKey(url.searchParams.get("q"));
    const matches = vehicles.filter(
      (item) =>
        // A partner account only sees the vehicles of its own company.
        (user.kind !== "PARTNER" || item.owner?.id === user.partner.id) && (!q || item.plateNo.includes(q)),
    );
    return page(request, response, url, matches.map(publicVehicle));
  },

  "POST /api/vehicles": async (request, response) => {
    if (!authorizeRoles(request, response, MASTER_WRITE_ROLES)) return 0;
    const created = { id: `v-${nextVehicleId++}`, isActive: true, verified: false };
    const problem = applyVehicle(created, { ...EMPTY_VEHICLE_BODY, ...(await readJson(request)) }, true);
    if (problem) return send(request, response, problem.status, problem.body);
    vehicles.unshift(created);
    return send(request, response, 201, { vehicle: publicVehicle(created) });
  },

  "PATCH /api/vehicles/:id": async (request, response, url, id) => {
    if (!authorizeRoles(request, response, MASTER_WRITE_ROLES)) return 0;
    const target = vehicles.find((item) => item.id === id);
    if (!target) return fail(request, response, 404, "NOT_FOUND", "No such vehicle");
    const problem = applyVehicle(target, await readJson(request), false);
    if (problem) return send(request, response, problem.status, problem.body);
    return send(request, response, 200, { vehicle: publicVehicle(target) });
  },

  // --- partners and destinations (staff) ------------------------------------

  "GET /api/partners": (request, response, url) => {
    if (!authorizeStaff(request, response)) return 0;
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
    if (!authorizeStaff(request, response)) return 0;
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
    if (!authorizeRoles(request, response, SYNC_ROLES)) return 0;
    const created = { id: `t-${nextDestinationId++}`, isActive: true };
    const fields = applyDestination(created, await readJson(request), true);
    if (fields) return invalid(request, response, fields);
    destinations.unshift(created);
    return send(request, response, 201, { destination: created });
  },

  "PATCH /api/destinations/:id": async (request, response, url, id) => {
    if (!authorizeRoles(request, response, SYNC_ROLES)) return 0;
    const target = destinations.find((item) => item.id === id);
    if (!target) return fail(request, response, 404, "NOT_FOUND", "No such destination");
    const fields = applyDestination(target, await readJson(request), false);
    if (fields) return invalid(request, response, fields);
    return send(request, response, 200, { destination: target });
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
  console.log("  other staff: super.contoh (system admin), pos.contoh (registration post), staf.baru (no role yet)");
});
