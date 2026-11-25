// Browser test of the built app against a REAL registration API, as section 3
// of docs/fase-3-penyelarasan.md describes. Not part of `npm test`.
//
//   NEXT_PUBLIC_API_URL=<the API address> npm run build
//   E2E_API_URL=<the API address> E2E_USERNAME=... E2E_PASSWORD=... node dev/e2e-real.mjs
//
// Environment (nothing is stored in files, nothing of it is printed):
//   E2E_API_URL    address of the API; the build must point at the same address
//   E2E_USERNAME   a local (password) account of that API. It needs: contracts view,
//   E2E_PASSWORD   drivers view, vehicles create, registrations create, gate edit
//                  and rfid_cards edit; registrations edit only if the API sends the
//                  registration to review
//   E2E_WEB_PORT   port for `next start` (default 3220); the API must accept that
//                  origin (WEB_ORIGIN of the API)
//   E2E_WEB_URL    an app that is already running, instead of starting one
//
// What it writes in the API's database: one test vehicle with a made-up plate
// ("ZZ" is no region code), one test card with a made-up UID, and one incoming
// registration whose truck is checked in and then cancelled. It creates no
// driver, so nothing is sent to the driver registry. At the end the card is set
// to RETIRED and the vehicle to inactive, so neither can be used by mistake.
//
// Output: PASS or FAIL lines and a count; exit code 0 when every check passed.

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, findBrowser, sleep, waitForHttp } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dev", ".e2e-real");
const API = (process.env.E2E_API_URL ?? "").replace(/\/+$/, "");
const USERNAME = process.env.E2E_USERNAME ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3220);
const WEB = (process.env.E2E_WEB_URL ?? `http://localhost:${WEB_PORT}`).replace(/\/+$/, "");
const WAIT_MS = 15000;

const children = [];
const results = [];

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  return child;
}

function check(name, passed) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
  return passed;
}

/** Stops the run with a FAIL line; the cleanup still runs. */
class Stop extends Error {}
function must(name, passed) {
  if (!check(name, passed)) throw new Stop(name);
}

// --- the API, with the token of the same account ------------------------------

let token = null;

async function call(method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

const LEVEL = { VIEW: 1, CREATE: 2, EDIT: 3 };
const holds = (permissions, code, level) => (LEVEL[permissions[code]] ?? 0) >= LEVEL[level];

const plantToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
const nextYear = () => `${new Date().getFullYear() + 1}-12-31`;
const hex = (length) => Array.from({ length }, () => "0123456789ABCDEF"[randomInt(16)]).join("");
const textOf = (selector) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').replace(/\\s+/g, ' ')`;
const visibleRows = `[...document.querySelectorAll('tbody tr')].filter((row) => row.offsetParent !== null).length`;

const created = { vehicle: null, card: null, registrationId: null, cancelled: false };

/** Two open purchase contracts of one partner with the same product category, so they share a flow. */
function pickContracts(items) {
  const groups = new Map();
  for (const item of items) {
    if (String(item.state).toUpperCase() !== "OPEN") continue;
    const key = `${item.partner.id}|${item.product.category ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].find((group) => group.length >= 2)?.slice(0, 2) ?? null;
}

async function prepare() {
  const login = await call("POST", "/api/auth/login", { username: USERNAME, password: PASSWORD });
  must("the account signs in to the API", login.status === 200 && typeof login.body?.accessToken === "string");
  token = login.body.accessToken;
  const permissions = login.body.user.permissions ?? {};
  const needed = [
    ["contracts", "VIEW"],
    ["drivers", "VIEW"],
    ["vehicles", "CREATE"],
    ["registrations", "CREATE"],
    ["gate", "EDIT"],
    ["rfid_cards", "EDIT"],
  ];
  const missing = needed.filter(([code, level]) => !holds(permissions, code, level)).map(([code, level]) => `${code} ${level}`);
  must(`the account holds the levels the flow needs${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`, login.body.user.kind === "INTERNAL" && missing.length === 0);

  const contracts = await call("GET", "/api/contracts?direction=IN&limit=200");
  const pair = contracts.status === 200 ? pickContracts(contracts.body.items) : null;
  must("two open purchase contracts of one partner exist", pair !== null);

  const types = await call("GET", "/api/vehicle-types");
  const type = types.body?.items?.find((item) => !item.needsContainerNo);
  must("a vehicle type without a container number exists", Boolean(type));

  const plateDisplay = `ZZ ${randomInt(1000, 10000)} E2E`;
  const vehicle = await call("POST", "/api/vehicles", {
    plateDisplay,
    vehicleTypeCode: type.code,
    capacityKg: 30000,
    stnkValidUntil: nextYear(),
    taxValidUntil: nextYear(),
    kirValidUntil: nextYear(),
  });
  must("a test vehicle with a made-up plate is created", vehicle.status === 201);
  created.vehicle = { id: vehicle.body.vehicle.id, plateDisplay: vehicle.body.vehicle.plateDisplay };

  // an existing driver: normal in the registry, licence valid, not blocked, not inside the plant
  const inside = await call("GET", "/api/trips?status=CHECKED_IN,IN_PROCESS&limit=200");
  const busy = new Set((inside.body?.items ?? []).map((trip) => String(trip.driver?.id)));
  const drivers = await call("GET", "/api/drivers?status=NORMAL&limit=100");
  let driver = null;
  for (const candidate of drivers.body?.items ?? []) {
    if (!candidate.isActive || candidate.licenceExpired || busy.has(String(candidate.id))) continue;
    const lookup = await call("GET", `/api/lookup/driver?licenceNo=${encodeURIComponent(candidate.licenceNo)}`);
    if (lookup.body?.driver && !lookup.body.driver.blocked) {
      driver = candidate;
      break;
    }
  }
  must("an existing driver is picked, none is created", driver !== null);

  const uid = `E2E0${hex(6)}`;
  const card = await call("POST", "/api/rfid-cards", { uid, label: "Kartu uji E2E", note: "Dibuat uji otomatis e2e-real" });
  must("a test card is registered", card.status === 201);
  created.card = { id: card.body.card.id, uid: card.body.card.uid };

  return { pair, driver, permissions };
}

// --- the flow in the browser ------------------------------------------------------

async function flow(browser, { pair, driver, permissions }) {
  const html = await (await fetch(`${WEB}/login`)).text();
  must("the build points at E2E_API_URL", html.includes(`${API}/api/auth/sso/start`));

  await browser.goto(`${WEB}/login`);
  await browser.type('input[name="username"]', USERNAME);
  await browser.type('input[name="password"]', PASSWORD);
  await browser.click('button[type="submit"]');
  must("signing in lands on Beranda", Boolean(await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Akun yang sedang masuk')")));

  await browser.click('a[href="/kontrak"]');
  check("Kontrak lists contracts", Boolean(await browser.waitFor(`location.pathname === '/kontrak' && ${visibleRows} > 0`)));

  // Staff do not type registrations in the web (owner's decision, 25 November 2026); the typed form is the
  // partner's. The API still takes one from staff, so the registration of this test is written through it.
  await browser.goto(`${WEB}/registrasi/baru?arah=in`);
  check("a staff account is refused the typed registration form", Boolean(await browser.hasText("Truk yang datang tanpa barcode didaftarkan di Pos registrasi lewat scan dokumen.")));
  const written = await call("POST", "/api/registrations", {
    direction: "IN",
    submit: true,
    plannedDate: plantToday(),
    allocations: pair.map((contract) => ({ contractId: contract.id })),
    trips: [
      {
        vehicle: { id: created.vehicle.id },
        driver: { id: driver.id },
        plannedArrival: plantToday(),
        letters: pair.map((_, index) => ({ allocationSeq: index + 1, originNetKg: 1000 })),
      },
    ],
  });
  must("the incoming registration with two contracts is sent", written.status === 201 && Boolean(written.body?.registration?.id));
  created.registrationId = String(written.body.registration.id);
  await browser.goto(`${WEB}/registrasi/${encodeURIComponent(created.registrationId)}`);
  check("the registration page lists both contracts", Boolean(await browser.waitFor(`${textOf("main")}.includes(${JSON.stringify(pair[0].contractNo)}) && ${textOf("main")}.includes(${JSON.stringify(pair[1].contractNo)})`)));

  if (await browser.waitFor("document.body.innerText.includes('Menunggu tinjauan')", 3000)) {
    must("the registration waits for review and the account may approve it", holds(permissions, "registrations", "EDIT"));
    await browser.click("Setujui");
    await browser.click('[role="dialog"] button[type="submit"]');
    await browser.hasText("Registrasi disetujui.");
  }
  must("the registration is approved and the truck has its SPJ", Boolean(await browser.waitFor(`Boolean(document.querySelector('a[aria-label="Cetak SPJ truk 1"]'))`)));

  const spjHref = await browser.evaluate(`document.querySelector('a[aria-label="Cetak SPJ truk 1"]').getAttribute('href')`);
  await browser.goto(`${WEB}${spjHref}`);
  const barcodes = await browser.waitFor(`Boolean(document.querySelector('[data-barcode="qr"] svg') && document.querySelector('[data-barcode="code128"] svg'))`);
  const sheet = (await browser.waitFor(textOf('[data-testid="spj-sheet"]'))) ?? "";
  check("the SPJ print page draws the QR code and the Code 128", Boolean(barcodes));
  check("the SPJ names both contracts", pair.every((contract) => sheet.includes(contract.contractNo)));
  const spjToken = ((await browser.evaluate(textOf('[data-testid="spj-token"]'))) ?? "").replace(/\s+/g, "");
  must("the SPJ shows its token", /^[0-9A-Z]{12}$/.test(spjToken));

  await browser.goto(`${WEB}/pos`);
  await browser.waitFor("document.activeElement?.id === 'gate-scan'");
  await browser.typeFocused(spjToken);
  await browser.pressEnter();
  must("the scan at the post asks for a card", Boolean(await browser.waitFor("document.activeElement?.id === 'gate-card'")));
  await browser.typeFocused(created.card.uid);
  await browser.pressEnter();
  must("the truck checks in with the test card", Boolean(await browser.waitFor(`${textOf('[data-testid="gate-success"]')}.includes('Check-in berhasil')`)));

  const cancelButton = `button[aria-label="Batalkan ${created.vehicle.plateDisplay}"]`;
  await browser.waitFor(`Boolean(document.querySelector(${JSON.stringify(cancelButton)}))`);
  await browser.click(cancelButton);
  await browser.fill('[role="dialog"] textarea[name="reason"]', "Uji otomatis e2e-real, dibatalkan");
  await browser.click('[role="dialog"] button[type="submit"]');
  must("the trip is cancelled at the post", Boolean(await browser.waitFor("document.body.innerText.includes('Kartunya kembali tersedia.')")));
  created.cancelled = true;

  const registration = await call("GET", `/api/registrations/${encodeURIComponent(created.registrationId)}`);
  check("the API shows the trip as cancelled", registration.body?.registration?.trips?.[0]?.status === "CANCELLED");
  const card = await call("GET", `/api/rfid-cards?q=${encodeURIComponent(created.card.uid)}&limit=5`);
  const row = card.body?.items?.find((item) => item.uid === created.card.uid);
  check("the test card is free again", row?.status === "AVAILABLE" && row.trip === null);
}

/** Leaves nothing usable behind: the card retired, the vehicle inactive, an unfinished registration cancelled. */
async function cleanUp() {
  if (!token) return;
  if (created.registrationId && !created.cancelled) {
    const cancelled = await call("POST", `/api/registrations/${encodeURIComponent(created.registrationId)}/cancel`, { reason: "Uji otomatis e2e-real" });
    check("cleanup: the unfinished test registration is cancelled", cancelled.status === 200);
  }
  if (created.card) {
    const retired = await call("PATCH", `/api/rfid-cards/${encodeURIComponent(String(created.card.id))}`, { status: "RETIRED" });
    check("cleanup: the test card is retired", retired.status === 200);
  }
  if (created.vehicle) {
    const inactive = await call("PATCH", `/api/vehicles/${encodeURIComponent(String(created.vehicle.id))}`, { isActive: false });
    check("cleanup: the test vehicle is set inactive", inactive.status === 200);
  }
}

// --- main ---------------------------------------------------------------------------

if (!API || !USERNAME || !PASSWORD) {
  console.error("Set E2E_API_URL, E2E_USERNAME and E2E_PASSWORD.");
  process.exit(2);
}
const executable = findBrowser();
if (!executable) {
  console.error("No Edge or Chrome found. Set SMOKE_BROWSER to the executable.");
  process.exit(2);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let browser;
let failure = null;
try {
  await waitForHttp(`${API}/api/health`, "the API");
  if (!process.env.E2E_WEB_URL) {
    start(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(WEB_PORT)], {
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
  }
  await waitForHttp(`${WEB}/login`, "the web app");
  const setup = await prepare();
  browser = await Browser.launch(executable, { profileDir: path.join(outDir, "profile"), outDir, waitMs: WAIT_MS, spawnChild: start });
  await browser.openPage();
  await flow(browser, setup);
} catch (error) {
  // a Stop has printed its FAIL line already; anything else is reported without its details
  if (!(error instanceof Stop)) check(`the run finished without an unexpected error (${error?.constructor?.name ?? "Error"})`, false);
  failure = error;
  if (browser) await browser.screenshot("failure").catch(() => {});
} finally {
  await cleanUp().catch(() => check("cleanup finished", false));
  if (browser) await browser.close();
  for (const child of children) child.kill();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(500);
    const removed = await rm(path.join(outDir, "profile"), { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
    if (removed) break;
  }
}

const failed = results.filter((result) => !result.passed).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failure || failed > 0 ? 1 : 0);
