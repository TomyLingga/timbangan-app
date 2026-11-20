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
    tolerancePct: direction === "IN" ? 0.3 : 0.15,
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
  contract("0123/CONTOH/CPO/XI/2026", "IN", partners.pksA, products.cpo, 1000000, { certificate: "ISCC" }),
  contract("0124/CONTOH/CPO/XI/2026", "IN", partners.pksA, products.cpo, 750000.5),
  contract("0125/CONTOH/CPO/XI/2026", "IN", partners.pksB, products.cpo, 2500000, { certificate: "RSPO", validUntil: "2027-01-31" }),
  contract("0126/CONTOH/PK/XI/2026", "IN", partners.pksB, products.kernel, 300000, { tolerancePct: 0.5 }),
  contract("0127/CONTOH/CPO/XI/2026", "IN", partners.pksC, products.cpo, 500000, { certificate: "ISCC" }),
  contract("0098/CONTOH/CPO/X/2026", "IN", partners.pksA, products.cpo, 1200000, { state: "CLOSED", validFrom: "2026-10-01", validUntil: "2026-10-31" }),
  contract("0101/CONTOH/CPO/X/2026", "IN", partners.pksC, products.cpo, 800000, { state: "CLOSED", validFrom: "2026-10-01", validUntil: "2026-11-15" }),
  contract("0045/CONTOH/OLEIN/XI/2026", "OUT", partners.customerA, products.olein, 2000000, { customerPoNo: "PO-CONTOH-0012", certificate: "ISCC" }),
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
  const allowed = [WEB_ORIGIN, WEB_ORIGIN.replace("localhost", "127.0.0.1")];
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

function startSession(request, response, user) {
  const refreshId = newId();
  sessions.set(refreshId, user.id);
  return send(
    request,
    response,
    200,
    { accessToken: issueAccessToken(user.id), user: publicUser(user) },
    { "set-cookie": refreshCookie(refreshId, 7 * 24 * 3600) },
  );
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
    const user = users.find((candidate) => candidate.username === key && candidate.password);
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
    if (user?.kind === "INTERNAL") tickets.set(ticket, { userId: user.id, expiresAt: Date.now() + TICKET_TTL_MS });
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

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }
  const key = `${request.method} ${url.pathname}`;
  const handler = routes[key];
  let status;
  try {
    status = handler
      ? await handler(request, response, url)
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
  console.log("  other staff: pos.contoh (no sync button), staf.baru (no role yet)");
});
