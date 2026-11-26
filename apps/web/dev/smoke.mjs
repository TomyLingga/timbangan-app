// End-to-end smoke check of the built app against dev/mock-api.mjs, driven
// through a headless Edge or Chrome over the DevTools protocol. No dependencies.
//
//   NEXT_PUBLIC_API_URL=http://localhost:3110 NEXT_PUBLIC_SCANNER_URL=http://127.0.0.1:3290 npm run build
//   node dev/smoke.mjs
//
// SMOKE_ONLY=gps, SMOKE_ONLY=pos, SMOKE_ONLY=pengiriman, SMOKE_ONLY=pks or SMOKE_ONLY=ubah runs one part alone against a
// fresh mock. The pos part plays the scanner
// helper of the post PC on 127.0.0.1:3290 (SMOKE_SCANNER_PORT), with the protocol of the old application's helper.
//
// The script starts the mock API and `next start` on its own ports, so it does
// not collide with a real API on 3100 or a dev server on 3000. Screenshots go
// to dev/.smoke/. Exit code 0 means every check passed.

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, findBrowser, sleep, waitForHttp } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dev", ".smoke");
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 3210);
const API_PORT = Number(process.env.SMOKE_API_PORT ?? 3110);
const WEB = `http://localhost:${WEB_PORT}`;
const API = `http://localhost:${API_PORT}`;
const SCANNER_PORT = Number(process.env.SMOKE_SCANNER_PORT ?? 3290);
const SCANNER = `http://127.0.0.1:${SCANNER_PORT}`;
// SMOKE_MODE=dev runs `next dev` instead of the build, which also exercises
// React Strict Mode (every effect mounts twice). Pages compile on first visit,
// so waits are longer.
const DEV_MODE = process.env.SMOKE_MODE === "dev";
const WAIT_MS = DEV_MODE ? 30000 : 8000;

const children = [];
const results = [];

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  return child;
}

function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// --- checks -----------------------------------------------------------------

const menuLinks = (browser) =>
  browser.evaluate(`[...document.querySelectorAll('aside nav a')].map((a) => a.getAttribute('href')).join(' ')`);

/** An access token for direct API calls, through the same portal round trip the browser uses. */
async function apiSession(username) {
  const start = await fetch(`${API}/api/auth/sso/start?as=${username}`, { redirect: "manual" });
  const ticket = new URL(start.headers.get("location") ?? "").searchParams;
  const exchange = await fetch(`${API}/api/auth/sso/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ticket.get("token"), appId: ticket.get("appId") }),
  });
  return (await exchange.json()).accessToken;
}

const visibleRows = `[...document.querySelectorAll('tbody tr')].filter((row) => row.offsetParent !== null).length`;
const stat = async (route) => (await (await fetch(`${API}/__mock/stats`)).json()).requests[route] ?? 0;
const location = (browser) => browser.evaluate("location.pathname + location.search");
/** Expression for the text of the visible table row that contains `needle`, on one line. */
const rowText = (needle) =>
  `([...document.querySelectorAll('tbody tr')].find((row) => row.offsetParent !== null && row.innerText.includes(${JSON.stringify(needle)}))?.innerText ?? '').replace(/\\s+/g, ' ')`;
const pageText = "document.body.innerText.replace(/\\s+/g, ' ')";
const inSheet = (selector) => `[role="dialog"] ${selector}`;
const isoDate = (yearsFromNow) => `${new Date().getFullYear() + yearsFromNow}-06-30`;

/** Picks the first option of a partner lookup after typing a part of the name. */
async function pickPartner(browser, inputSelector, text) {
  await browser.type(inputSelector, text);
  await browser.waitFor(`document.querySelector('[role="option"]')?.innerText.includes(${JSON.stringify(text)})`);
  await browser.click('[role="option"]');
}

async function signOut(browser) {
  // Sign-out sits in the account menu of the top bar.
  await browser.click('[data-testid="user-menu"]');
  await browser.click("Keluar");
  await browser.waitFor("location.pathname === '/login'");
}

async function run(browser) {
  // SMOKE_ONLY=gps runs only the GPS checks (42 to 48), against a fresh mock.
  if (process.env.SMOKE_ONLY === "gps") {
    await gpsTracking(browser);
    await driverSharing(browser);
    await destinationPins(browser);
    return;
  }
  // SMOKE_ONLY=pos runs only the checks of the registration post without a barcode, against a fresh mock.
  if (process.env.SMOKE_ONLY === "pos") {
    await postWithoutBarcode(browser);
    return;
  }
  // SMOKE_ONLY=pengiriman runs only the shipment requests, the DO to a customer and the Berita Acara print.
  if (process.env.SMOKE_ONLY === "pengiriman") {
    await shipmentAndCustomer(browser);
    await millRequests(browser);
    await changeAfterSend(browser);
    return;
  }
  // SMOKE_ONLY=pks runs only the mills supplying a trader's contract (API migration 0018).
  if (process.env.SMOKE_ONLY === "pks") {
    await millRequests(browser);
    return;
  }
  // SMOKE_ONLY=ubah runs only the change of a registration after it was sent.
  if (process.env.SMOKE_ONLY === "ubah") {
    await changeAfterSend(browser);
    return;
  }
  // 1. Server HTML of the sign-in page.
  const html = await (await fetch(`${WEB}/login`)).text();
  if (!html.includes(`${API}/api/auth/sso/start`)) {
    throw new Error(`the build does not point at ${API}; rebuild with NEXT_PUBLIC_API_URL=${API}`);
  }
  check(
    "/login server HTML has the portal link and both form fields",
    html.includes("Masuk lewat Portal INL") && html.includes('name="username"') && html.includes('name="password"'),
  );
  check('/login server HTML is marked lang="id"', html.includes('<html lang="id"'));

  // 2. Sign-in form: validation, wrong password, success.
  await browser.colorScheme("light");
  await browser.goto(`${WEB}/login`);
  check("light system setting gives the light theme", !(await browser.evaluate("document.documentElement.classList.contains('dark')")));
  check("/login renders in the browser", Boolean(await browser.hasText("Masuk lewat Portal INL")));
  await browser.screenshot("01-login-light");
  await browser.click('button[type="submit"]');
  check("empty form shows a field message in Indonesian", Boolean(await browser.hasText("Isi nama pengguna.")));

  await browser.type('input[name="username"]', "pks.contoh.a");
  await browser.type('input[name="password"]', "salah");
  await browser.click('button[type="submit"]');
  check("wrong password shows the API error in Indonesian", Boolean(await browser.hasText("Nama pengguna atau kata sandi salah.")));

  await browser.evaluate(`document.querySelector('input[name="password"]').select()`);
  await browser.type('input[name="password"]', "contoh-123");
  await browser.click('button[type="submit"]');
  check("partner sign-in lands on Beranda", Boolean(await browser.waitFor("location.pathname === '/'")) && Boolean(await browser.hasText("Akun yang sedang masuk")));
  check("header shows name and company, no role label", Boolean(await browser.waitFor(`(() => {
    const text = document.querySelector('[data-testid="header-identity"]')?.innerText ?? '';
    return text.includes('Admin PKS Contoh A') && text.includes('PKS Contoh A') && !text.includes('PKS / supplier');
  })()`)));
  check(
    "Beranda summarises the access of the account",
    Boolean(await browser.waitFor(`document.querySelector('[data-testid="access-summary"]')?.innerText.includes('Kontrak: lihat')`)),
  );
  check("Beranda shows API health", Boolean(await browser.hasText("Terhubung")));
  check("partner account gets no Odoo panel", !(await browser.evaluate("document.body.innerText.includes('Salinan data dari Odoo')")));
  check(
    "a partner's Beranda has no stage list, no plant map and no error, and asks for neither",
    (await browser.evaluate(`!document.querySelector('[aria-label="Truk per tahap"]') && !document.querySelector('[data-testid="home-plant"]') && !document.querySelector('main [role="alert"]')`)) &&
      (await stat("GET /api/trips/flow")) === 0 &&
      (await stat("GET /api/control-room/state")) === 0,
  );
  check(
    "a partner's Beranda counts its own registrations, and its bell counts notifications, not requests waiting",
    Boolean(await browser.waitFor(`${pageText}.includes(' registrasi') && document.querySelector('[data-testid="notifications-bell"]')?.dataset.mode === 'unread'`)),
  );
  check(
    "an empty inbox puts no number on the bell and says so in its label",
    Boolean(await browser.waitFor(`document.querySelector('[data-testid="notifications-bell"]')?.getAttribute('aria-label') === 'Pemberitahuan, semua sudah dibaca' && !document.querySelector('[data-testid="bell-badge"]')`)),
  );
  await browser.click('[data-testid="notifications-bell"]');
  check(
    "the empty inbox says so in one line",
    Boolean(await browser.waitFor(`document.querySelector('[data-testid="notifications-empty"]')?.innerText.trim() === 'Belum ada pemberitahuan.'`)),
  );
  await browser.pressEscape();
  check("Escape closes the panel and gives focus back to the bell", Boolean(await browser.waitFor(`!document.querySelector('[data-testid="notifications-panel"]') && document.activeElement?.dataset.testid === 'notifications-bell'`)));
  check("access token is not in web storage", await browser.evaluate("JSON.stringify({...localStorage, ...sessionStorage}).length < 40"));
  await browser.screenshot("02-beranda-partner");

  // 3. Kontrak list for a partner.
  await browser.click('a[href="/kontrak"]');
  const partnerRows = await browser.waitFor(visibleRows);
  check("/kontrak shows rows after signing in", partnerRows === 2, `${partnerRows} rows`);
  const tableText = await browser.evaluate("document.querySelector('table')?.innerText ?? ''");
  check("quantity uses Indonesian grouping with the unit", tableText.includes("1.000.000 Kg") && tableText.includes("750.000,5 Kg"));
  check("date reads as 31 Des 2026 and tolerance as 0,25%", tableText.includes("31 Des 2026") && tableText.includes("0,25%"));
  check("partner account has no sync button", !(await browser.evaluate("document.body.innerText.includes('Ambil dari Odoo')")));

  // 4. Expired access token: one refresh, one retry, list still loads.
  const refreshesBefore = await stat("POST /api/auth/refresh");
  await fetch(`${API}/__mock/expire-access-tokens`, { method: "POST" });
  await browser.click('[role="switch"]');
  const withClosed = await browser.waitFor(`${visibleRows} === 3 && ${visibleRows}`);
  check("expired token is renewed and the list reloads with closed contracts", withClosed === 3 && (await stat("POST /api/auth/refresh")) === refreshesBefore + 1);
  check("closed contract is labelled Tutup", await browser.evaluate("document.querySelector('table').innerText.includes('Tutup')"));

  // 5. Search is debounced: typing several keys makes one request.
  const contractCallsBefore = await stat("GET /api/contracts");
  await browser.type('input[type="search"]', "0098", { perKey: true });
  const searched = await browser.waitFor(`${visibleRows} === 1 && ${visibleRows}`);
  await sleep(500);
  const contractCalls = (await stat("GET /api/contracts")) - contractCallsBefore;
  check("search narrows the list with one request for four keystrokes", searched === 1 && contractCalls === 1, `${contractCalls} request(s)`);
  await browser.type('input[type="search"]', "zzz");
  check("empty state text", Boolean(await browser.hasText("Tidak ada kontrak yang cocok")));

  // 6. Reload keeps the session through the refresh cookie.
  await browser.goto(`${WEB}/kontrak`);
  check("reload stays signed in and shows rows again", (await browser.waitFor(visibleRows)) === 2);

  // 7. Outgoing tab for a supplier is empty.
  await browser.click("Outgoing (penjualan)");
  check("Outgoing tab for a supplier shows the empty state", Boolean(await browser.hasText("Tidak ada kontrak yang cocok")));

  // 8. Sign out, then the guard sends an anonymous visitor to /login.
  await signOut(browser);
  check("sign-out goes to /login", (await location(browser)) === "/login");
  await browser.goto(`${WEB}/kontrak`);
  check("signed-out visit to /kontrak is sent to /login", Boolean(await browser.waitFor("location.pathname === '/login'")));

  // 8b. A session that ends on the server: one refresh is refused, then /login.
  await browser.type('input[name="username"]', "pks.contoh.a");
  await browser.type('input[name="password"]', "contoh-123");
  await browser.click('button[type="submit"]');
  await browser.hasText("Akun yang sedang masuk");
  await fetch(`${API}/__mock/end-sessions`, { method: "POST" });
  await browser.click('a[href="/kontrak"]');
  check(
    "a session ended by the server leads to /login with a notice",
    Boolean(await browser.waitFor("location.pathname === '/login' && document.body.innerText.includes('Sesi berakhir.')")),
  );

  // 9. Portal sign-in that lands on the ROOT route with ?token=…&appId=….
  await browser.goto(`${API}/api/auth/sso/start?as=admin.contoh`);
  const rootLanding = await browser.waitFor("location.pathname === '/' && location.search === '' && document.body.innerText.includes('Admin Contoh')");
  check("/?token&appId is exchanged and ends on / without the query", Boolean(rootLanding), await location(browser));
  const historyAfterRoot = await browser.historyUrls();
  check("no history entry keeps the token (root landing)", !historyAfterRoot.some((url) => url.startsWith(WEB) && url.includes("token=")));
  check("staff account sees the Odoo panel on Beranda", Boolean(await browser.hasText("Salinan data dari Odoo")));
  check(
    "Beranda of staff without the control room lists the trucks per stage from GET /api/trips/flow, without a map",
    Boolean(await browser.waitFor(`(document.querySelector('[aria-label="Truk per tahap"]')?.innerText ?? '').replace(/\\s+/g, ' ').includes('Akan datang 1')`)) &&
      (await browser.evaluate(`!document.querySelector('[data-testid="home-plant"]') && !document.querySelector('main svg filter')`)) &&
      (await stat("GET /api/trips/flow")) > 0 &&
      (await stat("GET /api/control-room/state")) === 0,
  );
  check("exchange was called once for the root landing", (await stat("POST /api/auth/sso/exchange")) === 1);

  // 10. Admin: sync button, counts, list reload, Outgoing tab.
  await browser.click('a[href="/kontrak"]');
  const adminRows = await browser.waitFor(visibleRows);
  // five of the mills and the trader's contract 0130 that several mills supply (API migration 0018)
  check("admin sees all open incoming contracts", adminRows === 6, `${adminRows} rows`);
  await browser.screenshot("03-kontrak-admin-light");
  await browser.click("Ambil dari Odoo");
  const summary = await browser.waitFor("[...document.querySelectorAll('p')].find((p) => p.innerText.startsWith('Selesai dalam'))?.innerText", 10000);
  check("sync shows duration and counts", Boolean(summary) && summary.includes("14 kontrak") && summary.includes("Dilewati: 1."), summary ?? "no summary");
  check("list reloads after the sync", (await browser.waitFor(`${visibleRows} === 7 && ${visibleRows}`)) === 7);
  await browser.click("Outgoing (penjualan)");
  check("Outgoing tab shows sales contracts with the customer PO", Boolean(await browser.waitFor(`${visibleRows} === 4`)) && Boolean(await browser.hasText("PO PO-CONTOH-0012")));
  await browser.goto(`${WEB}/`);
  check("Beranda shows the last sync per data set", Boolean(await browser.hasText("Berhasil")) && Boolean(await browser.hasText("14 baris")));
  await browser.screenshot("04-beranda-admin-light");

  // 11. Dark theme and phone layout.
  await browser.colorScheme("dark");
  await browser.goto(`${WEB}/kontrak`);
  await browser.waitFor(visibleRows);
  check("dark system setting gives the dark theme", await browser.evaluate("document.documentElement.classList.contains('dark')"));
  await browser.screenshot("05-kontrak-admin-dark");
  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/kontrak`);
  const cards = await browser.waitFor("[...document.querySelectorAll('main ul > li')].filter((li) => li.offsetParent !== null).length");
  check("phone width shows cards instead of the table", cards === 7 && (await browser.evaluate(visibleRows)) === 0, `${cards} cards`);
  check("phone width has no horizontal scroll", await browser.evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
  await browser.screenshot("06-kontrak-phone-dark");
  await browser.click('button[aria-label="Buka menu"]');
  check("drawer lists the pages of a logistics admin and no planned entries", Boolean(await browser.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const links = [...dialog.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    // Every page but Pengguna for a logistics admin. The plant map now is the control room (module dashboard),
    // which this account does not hold, so nothing is listed as planned any more.
    // the logistics admin also holds the modules of phase 4: Keputusan, Laporan, Stasiun
    // and since migration 0006 the plant masters: Tangki and Segel
    // Tujuan left the menu: the destination is typed on each DO (owner's decision, 22 November 2026)
    // and since migration 0011 Lacak kendaraan (gps), since migration 0017 Permintaan pengiriman
    const expected = ['/', '/registrasi', '/permintaan-pengiriman', '/delivery-order', '/pos', '/lacak', '/keputusan', '/kontrak', '/supir', '/kendaraan', '/kartu', '/tangki', '/segel', '/laporan', '/riwayat', '/stasiun'];
    return !dialog.innerText.includes('Belum tersedia') && links.join() === expected.join();
  })()`)));
  await browser.screenshot("07-drawer-phone-dark");
  await browser.colorScheme("light");
  await browser.goto(`${WEB}/`);
  await browser.waitFor("document.body.innerText.includes('Akun yang sedang masuk')");
  await browser.screenshot("08-beranda-phone-light");
  await browser.viewport(1366, 900);
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  // 12. /auth/sso opened directly keeps working.
  await browser.goto(`${API}/api/auth/sso/start?as=pos.contoh&to=callback`);
  check("/auth/sso?token&appId opened directly signs in and ends on /", Boolean(await browser.waitFor("location.pathname === '/' && location.search === '' && document.body.innerText.includes('Petugas Pos Contoh')")));
  check("no history entry keeps the token (direct callback)", !(await browser.historyUrls()).some((url) => url.startsWith(WEB) && url.includes("token=")));
  await browser.click('a[href="/kontrak"]');
  await browser.waitFor(visibleRows);
  check("a role without sync rights has no sync button", !(await browser.evaluate("document.body.innerText.includes('Ambil dari Odoo')")));
  await signOut(browser);

  // 13. Rejected ticket.
  await browser.goto(`${WEB}/?token=bukan-tiket&appId=mock-app`);
  check("a rejected ticket explains what happened", Boolean(await browser.hasText("Portal menolak tiket masuk ini.")));
  check("the rejected token is removed from the address bar", (await location(browser)) === "/auth/sso");
  check("the failure page links back to /login", await browser.evaluate(`Boolean(document.querySelector('a[href="/login"]'))`));
  await browser.screenshot("09-sso-rejected");
  await browser.goto(`${WEB}/auth/sso`);
  check("/auth/sso without a ticket says the link is incomplete", Boolean(await browser.hasText("Tautan masuk ini tidak lengkap.")));

  // 14. Staff account without any permission.
  await browser.goto(`${API}/api/auth/sso/start?as=staf.baru`);
  check("staff without access sees the waiting page with the name", Boolean(await browser.hasText("Menunggu hak akses")) && Boolean(await browser.hasText("Staf Baru Contoh")));
  await browser.screenshot("10-no-access");
  await browser.click("Keluar");
  check("sign-out works from the waiting page", Boolean(await browser.waitFor("location.pathname === '/login'")));

  // 15. Supir, as a logistics admin: totals per status, search, filter, VCF sync, new driver.
  await browser.goto(`${API}/api/auth/sso/start?as=admin.contoh`);
  await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Admin Contoh')");
  check("menu has Supir and Kendaraan but neither Tujuan nor Pengguna for a logistics admin", await browser.evaluate(`(() => {
    const links = [...document.querySelectorAll('aside nav a')].map((a) => a.getAttribute('href'));
    return ['/supir', '/kendaraan'].every((href) => links.includes(href)) && !links.includes('/pengguna') && !links.includes('/tujuan');
  })()`));
  await browser.click('a[href="/supir"]');
  check("/supir lists the drivers", (await browser.waitFor(visibleRows)) === 10);
  const chipGroup = '[aria-label="Saring menurut status VCF"]';
  const chipText = `(() => { const text = document.querySelector('${chipGroup}')?.innerText.replace(/\\s+/g, ' ') ?? ''; return text.includes('…') ? '' : text; })()`;
  const chips = (await browser.waitFor(chipText)) ?? "";
  check(
    "status chips carry the total of each status",
    ["Semua 10", "Normal 4", "Warning 2", "Blacklist 1", "Belum ada di VCF 3"].every((part) => chips.includes(part)),
    chips,
  );
  check("an expired licence is marked", (await browser.evaluate(rowText("Supir Contoh 05"))).includes("(lewat)"));
  const pushGroup = '[aria-label="Saring menurut pengiriman ke VCF"]';
  const pushChipText = `(() => { const text = document.querySelector('${pushGroup}')?.innerText.replace(/\\s+/g, ' ') ?? ''; return text.includes('…') ? '' : text; })()`;
  const pushChips = (await browser.waitFor(pushChipText)) ?? "";
  check(
    "push chips carry the number waiting and failed",
    ["Semua 10", "Menunggu dikirim 1", "Gagal dikirim 1"].every((part) => pushChips.includes(part)),
    pushChips,
  );
  check("a driver waiting to be sent is marked", (await browser.evaluate(rowText("Supir Contoh 09"))).includes("Menunggu dikirim ke VCF"));
  const failedRow = await browser.evaluate(rowText("Supir Contoh 10"));
  check(
    "a driver that failed to be sent is marked, with the reason hidden",
    failedRow.includes("Gagal dikirim ke VCF") && failedRow.includes("Lihat alasan") && !failedRow.includes("licence class not accepted"),
    failedRow,
  );
  await browser.click('tbody button[aria-expanded="false"]');
  check(
    "the failure reason is shown on request",
    Boolean(await browser.waitFor(`${rowText("Supir Contoh 10")}.includes('Pesan server: Registry refused the record')`)) &&
      (await browser.evaluate(`document.querySelector('tbody button[aria-expanded]').getAttribute('aria-expanded') === 'true'`)),
  );
  await browser.screenshot("11-supir-light");
  await browser.type('input[type="search"]', "contoh 03", { perKey: true });
  check("driver search narrows the list", (await browser.waitFor(`${visibleRows} === 1 && ${visibleRows}`)) === 1 && (await browser.evaluate(rowText("Supir Contoh 03"))).includes("Warning"));
  await browser.click('button[aria-label="Hapus pencarian"]');
  await browser.waitFor(`${visibleRows} === 10`);
  await browser.click(`${chipGroup} button:nth-child(4)`);
  check(
    "status filter shows only blacklisted drivers",
    (await browser.waitFor(`${visibleRows} === 1 && ${visibleRows}`)) === 1 &&
      (await browser.evaluate(rowText("Supir Contoh 04"))).includes("Blacklist") &&
      (await browser.evaluate(`document.querySelector('${chipGroup} button:nth-child(4)').getAttribute('aria-pressed') === 'true'`)),
  );
  await browser.click(`${chipGroup} button:nth-child(1)`);
  await browser.waitFor(`${visibleRows} === 10`);
  await browser.click(`${pushGroup} button:nth-child(3)`);
  check(
    "push filter shows only the driver that failed to be sent",
    (await browser.waitFor(`${visibleRows} === 1 && ${visibleRows}`)) === 1 && (await browser.evaluate(rowText("Supir Contoh 10"))).includes("Gagal dikirim ke VCF"),
  );
  await browser.click(`${pushGroup} button:nth-child(2)`);
  check(
    "push filter shows only the driver waiting to be sent",
    Boolean(await browser.waitFor(`${visibleRows} === 1 && ${rowText("Supir Contoh 09")} !== ''`)),
  );
  await browser.click(`${pushGroup} button:nth-child(1)`);
  await browser.waitFor(`${visibleRows} === 10`);

  await browser.click("Ambil dari VCF");
  const vcfSummary = await browser.waitFor("[...document.querySelectorAll('p')].find((p) => p.innerText.startsWith('Selesai dalam'))?.innerText", 10000);
  check(
    "VCF sync shows the counts taken, sent and failed",
    Boolean(vcfSummary) && ["10 supir", "2 transporter", "Dikirim ke VCF: 1 supir, gagal 1."].every((part) => vcfSummary.includes(part)),
    vcfSummary ?? "no summary",
  );
  check("page shows the time of the last VCF sync", Boolean(await browser.hasText("Terakhir diambil dari VCF")));
  check("totals follow the sync", Boolean(await browser.waitFor(`${chipText}.includes('Belum ada di VCF 1') && ${pushChipText}.includes('Menunggu dikirim 0') && ${pushChipText}.includes('Gagal dikirim 1')`)));
  check("the driver that was sent is no longer marked", !(await browser.evaluate(rowText("Supir Contoh 09"))).includes("dikirim ke VCF"));

  await browser.click("Supir baru");
  await browser.click(inSheet('button[type="submit"]'));
  check("driver form asks for the required fields", Boolean(await browser.hasText("Isi nomor SIM.")) && Boolean(await browser.hasText("Pilih jenis SIM.")));
  check("driver form says the driver is also sent to VCF", Boolean(await browser.hasText("juga dikirim ke VCF")));
  await browser.fill(inSheet('input[name="fullName"]'), "Uji Asap Satu");
  await browser.fill(inSheet('input[name="licenceNo"]'), "uji0001");
  await browser.fill(inSheet('select[name="licenceClass"]'), "B2 UMUM");
  await browser.fill(inSheet('input[name="licenceValidUntil"]'), isoDate(2));
  await browser.click(inSheet('button[type="submit"]'));
  check("new driver is saved and the returned push state is shown", Boolean(await browser.hasText("Supir Uji Asap Satu ditambahkan dan menunggu dikirim ke VCF.")));
  const newDriver = await browser.waitFor(rowText("Uji Asap Satu"));
  check(
    "new driver is listed as not yet in VCF and waiting to be sent",
    Boolean(newDriver) && ["UJI0001", "Belum ada di VCF", "Menunggu dikirim ke VCF"].every((part) => newDriver.includes(part)),
    newDriver ?? "",
  );
  await browser.click("Supir baru");
  await browser.fill(inSheet('input[name="fullName"]'), "Uji Asap Dua");
  await browser.fill(inSheet('input[name="licenceNo"]'), "UJI0001");
  await browser.fill(inSheet('select[name="licenceClass"]'), "B1");
  await browser.fill(inSheet('input[name="licenceValidUntil"]'), isoDate(1));
  await browser.click(inSheet('button[type="submit"]'));
  check("a duplicate licence number is explained", Boolean(await browser.hasText("Nomor SIM ini sudah terdaftar.")));
  await browser.click("Batal");

  // 16. Kendaraan: list, plate check, create with an expired tax date, edit the tare.
  await browser.click('a[href="/kendaraan"]');
  check("/kendaraan lists the vehicles", (await browser.waitFor(`location.pathname === '/kendaraan' && ${visibleRows} === 5 && ${visibleRows}`)) === 5);
  check(
    "expired documents are summarised per vehicle",
    (await browser.evaluate(rowText("ZZ 0002 CTH"))).includes("KIR lewat") &&
      (await browser.evaluate(rowText("ZZ 0004 CTH"))).includes("STNK lewat, Pajak lewat"),
  );
  await browser.click("Kendaraan baru");
  await browser.fill(inSheet('input[name="plateDisplay"]'), "z1");
  await browser.click(inSheet('button[type="submit"]'));
  check("a plate that is too short is refused before sending", Boolean(await browser.hasText("Plat terdiri dari 3 sampai 12 huruf dan angka.")) && (await stat("POST /api/vehicles")) === 0);
  await browser.fill(inSheet('input[name="plateDisplay"]'), "zz 9001 uji");
  await browser.fill(inSheet('select[name="vehicleTypeCode"]'), "TANGKI");
  await pickPartner(browser, inSheet('input[name="ownerLookup"]'), "Contoh B");
  await browser.fill(inSheet('select[name="ownership"]'), "MITRA");
  await browser.fill(inSheet('input[name="capacityKg"]'), "12000");
  await browser.fill(inSheet('input[name="productionYear"]'), "2021");
  await browser.fill(inSheet('input[name="tareKg"]'), "6000");
  await browser.fill(inSheet('input[name="stnkValidUntil"]'), isoDate(2));
  await browser.fill(inSheet('input[name="taxValidUntil"]'), "2020-01-15");
  await browser.screenshot("12-kendaraan-form-light");
  await browser.click(inSheet('button[type="submit"]'));
  check("new vehicle is saved", Boolean(await browser.hasText("Kendaraan ZZ 9001 UJI ditambahkan.")));
  const newVehicle = (await browser.waitFor(rowText("ZZ 9001 UJI"))) ?? "";
  check(
    "new vehicle is listed with its owner, numbers and the expired tax date marked",
    ["Truk tangki", "Transporter Contoh B", "12.000 Kg", "6.000 Kg", "Pajak lewat", "15 Jan 2020 (lewat)"].every((part) => newVehicle.includes(part)),
    newVehicle,
  );
  await browser.click('button[aria-label="Ubah ZZ 9001 UJI"]');
  await browser.waitFor(`document.querySelector('${inSheet('input[name="tareKg"]')}')?.value === '6000'`);
  check("tare reason is hidden until the tare is edited", !(await browser.evaluate(`Boolean(document.querySelector('textarea[name="tareReason"]'))`)));
  await browser.fill(inSheet('input[name="tareKg"]'), "6100");
  check("tare reason appears when the tare is edited", Boolean(await browser.waitFor(`Boolean(document.querySelector('textarea[name="tareReason"]'))`)));
  await browser.click(inSheet('button[type="submit"]'));
  check("a changed tare needs a reason", Boolean(await browser.hasText("Isi alasan perubahan tarra.")));
  await browser.fill('textarea[name="tareReason"]', "Ganti bak (uji)");
  await browser.click(inSheet('button[type="submit"]'));
  check("edited vehicle shows the new tare", Boolean(await browser.hasText("Kendaraan ZZ 9001 UJI diperbarui.")) && Boolean(await browser.waitFor(`${rowText("ZZ 9001 UJI")}.includes('6.100 Kg')`)));
  await browser.type('input[type="search"]', "zz0003", { perKey: true });
  check("plate search ignores spaces", (await browser.waitFor(`${visibleRows} === 1 && ${visibleRows}`)) === 1 && (await browser.evaluate(rowText("ZZ 0003 CTH"))).includes("Truk bak"));
  await browser.click('button[aria-label="Hapus pencarian"]');
  await browser.waitFor(`${visibleRows} === 6`);
  await browser.screenshot("13-kendaraan-light");
  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/kendaraan`);
  const vehicleCards = await browser.waitFor("[...document.querySelectorAll('main ul > li')].filter((li) => li.offsetParent !== null).length");
  check("phone width shows vehicle cards without horizontal scroll", vehicleCards === 6 && (await browser.evaluate("document.documentElement.scrollWidth <= window.innerWidth")), `${vehicleCards} cards`);
  await browser.screenshot("14-kendaraan-phone-light");
  await browser.goto(`${WEB}/supir`);
  const driverCards = await browser.waitFor("[...document.querySelectorAll('main ul > li')].filter((li) => li.offsetParent !== null).length");
  check(
    "phone width shows driver cards with the push marks and no horizontal scroll",
    driverCards === 11 &&
      Boolean(await browser.hasText("Gagal dikirim ke VCF")) &&
      (await browser.evaluate("document.documentElement.scrollWidth <= window.innerWidth")),
    `${driverCards} cards`,
  );
  await browser.screenshot("14b-supir-phone-light");
  await browser.viewport(1366, 900);

  // 17. The destinations master is no longer offered: not in the menu, not in the command palette.
  await browser.goto(`${WEB}/`);
  await browser.waitFor("document.body.innerText.includes('Akun yang sedang masuk')");
  await browser.click('button[aria-label="Cari halaman"][aria-keyshortcuts]');
  await browser.waitFor(`document.querySelector('[role="listbox"][aria-label="Halaman"]')`);
  await browser.type('input[aria-label="Cari halaman"]', "tujuan");
  check(
    "the command palette has no Tujuan page",
    Boolean(await browser.waitFor(`document.querySelector('[role="listbox"][aria-label="Halaman"]')?.innerText.includes('Tidak ada halaman dengan nama itu.')`)),
  );
  await browser.pressEscape();

  // 18. Beranda shows the VCF sync next to the Odoo sync; /pengguna is refused without the users module.
  await browser.goto(`${WEB}/`);
  check("Beranda shows the last VCF sync", Boolean(await browser.hasText("Salinan data dari VCF")) && Boolean(await browser.waitFor(`${pageText}.includes('Supir Berhasil')`)));
  await browser.goto(`${WEB}/pengguna`);
  check(
    "/pengguna shows the no-access page to an account without the users module",
    Boolean(await browser.hasText("Anda tidak punya akses ke halaman ini")) &&
      Boolean(await browser.hasText("modul Pengguna dan hak akses")) &&
      (await stat("GET /api/admin/users")) === 0,
  );
  await signOut(browser);

  // 19. An account with users EDIT gives levels per module, within what the account kind allows.
  await browser.goto(`${API}/api/auth/sso/start?as=super.contoh`);
  await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Admin Sistem Contoh')");
  await browser.click('a[href="/pengguna"]');
  check("/pengguna lists the accounts", (await browser.waitFor(visibleRows)) === 12);
  check("the page says what it is for", Boolean(await browser.hasText("belum punya hak akses")));
  await browser.type('input[type="search"]', "staf.baru", { perKey: true });
  await browser.waitFor(`${visibleRows} === 1 && ${rowText("Staf Baru Contoh")} !== ''`);
  check("an account without access is marked", (await browser.evaluate(rowText("Staf Baru Contoh"))).includes("Belum ada akses"));
  await browser.click('button[aria-label="Atur hak akses Staf Baru Contoh"]');
  const staffModules = await browser.waitFor(`[...document.querySelectorAll('[role="dialog"] select')].map((s) => s.name).join(' ')`);
  check(
    "a staff account is offered every module, each with its own levels",
    ["contracts", "drivers", "vehicles", "delivery_orders", "registrations", "gate", "rfid_cards", "users", "weighbridge", "approvals", "qc", "qc_approvals", "security_check", "unloading", "loading", "sealing", "reports"].every((code) =>
      (staffModules ?? "").includes(`permission-${code}`),
    ) &&
      // the destinations master is switched off (API migration 0009)
      !(staffModules ?? "").includes("permission-destinations") &&
      (await browser.evaluate(`[...document.querySelector('[role="dialog"] select[name="permission-contracts"]').options].map((o) => o.value).join(',') === ',VIEW,EDIT'`)),
    staffModules ?? "",
  );
  await browser.fill(inSheet('select[name="permission-registrations"]'), "VIEW");
  await browser.fill(inSheet('select[name="permission-vehicles"]'), "VIEW");
  await browser.fill(inSheet('select[name="permission-gate"]'), "VIEW");
  await browser.screenshot("16-pengguna-hak-akses-light");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "the levels are saved and summarised in the list",
    Boolean(await browser.hasText("Hak akses Staf Baru Contoh disimpan.")) &&
      Boolean(await browser.waitFor(`${rowText("Staf Baru Contoh")}.includes('Kendaraan: lihat · Registrasi: lihat · Pos registrasi: lihat')`)),
  );

  await browser.click('button[aria-label="Hapus pencarian"]');
  await browser.type('input[type="search"]', "pks.contoh.a", { perKey: true });
  await browser.waitFor(`${visibleRows} === 1 && ${rowText("Admin PKS Contoh A")} !== ''`);
  await browser.click('button[aria-label="Atur hak akses Admin PKS Contoh A"]');
  const partnerModules = (await browser.waitFor(`[...document.querySelectorAll('[role="dialog"] select')].map((s) => s.name).join(' ')`)) ?? "";
  check(
    "a partner account is offered only the modules allowed for partners",
    // gps is allowed for partners since migration 0011 (apps/api)
    // and shipment_requests since migration 0017
    partnerModules === "permission-contracts permission-drivers permission-vehicles permission-delivery_orders permission-registrations permission-gps permission-shipment_requests",
    partnerModules,
  );
  await browser.click("Beri semua");
  check(
    "give all raises every offered module to its highest level",
    Boolean(await browser.waitFor(`document.querySelector('[role="dialog"] select[name="permission-delivery_orders"]').value === 'EDIT' && document.querySelector('[role="dialog"] select[name="permission-contracts"]').value === 'EDIT'`)),
  );
  await browser.click("Cabut semua");
  check("revoke all empties every module", Boolean(await browser.waitFor(`[...document.querySelectorAll('[role="dialog"] select')].every((s) => s.value === '')`)));
  await browser.click("Batal");
  const admin = await apiSession("super.contoh");
  const refusedForPartner = await fetch(`${API}/api/admin/users/u-4/permissions`, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ permissions: { contracts: "VIEW", gate: "VIEW" } }),
  });
  const refusedBody = await refusedForPartner.json();
  check(
    "the API refuses a module that is not allowed for partners",
    refusedForPartner.status === 400 && refusedBody.error.fields.some((field) => field.field === "permissions.gate"),
    `${refusedForPartner.status}`,
  );

  // The emergency local account also holds users EDIT; switched off, the system admin is the last one.
  await browser.click('button[aria-label="Hapus pencarian"]');
  await browser.type('input[type="search"]', "petugas.lokal", { perKey: true });
  await browser.waitFor(`${visibleRows} === 1 && ${rowText("Petugas Lokal Contoh")} !== ''`);
  await browser.click('tbody [role="switch"]');
  check("another account is switched off", Boolean(await browser.hasText("Akun Petugas Lokal Contoh dinonaktifkan.")));
  await browser.click('button[aria-label="Hapus pencarian"]');
  await browser.type('input[type="search"]', "super.contoh", { perKey: true });
  await browser.waitFor(`${visibleRows} === 1 && ${rowText("Admin Sistem Contoh")} !== ''`);
  await browser.click('tbody [role="switch"]');
  check("switching off one's own account is explained", Boolean(await browser.hasText("Anda tidak bisa menonaktifkan akun Anda sendiri.")));
  await browser.click('button[aria-label="Atur hak akses Admin Sistem Contoh"]');
  await browser.click("Cabut semua");
  await browser.click(inSheet('button[type="submit"]'));
  check("taking the access of the last admin away is explained", Boolean(await browser.hasText("Harus tetap ada satu akun karyawan aktif yang bisa mengatur hak akses.")));
  await browser.click("Batal");
  await browser.click('button[aria-label="Hapus pencarian"]');
  await browser.type('input[type="search"]', "petugas.lokal", { perKey: true });
  await browser.waitFor(`${visibleRows} === 1 && ${rowText("Petugas Lokal Contoh")} !== ''`);
  await browser.click('tbody [role="switch"]');
  await browser.hasText("Akun Petugas Lokal Contoh diaktifkan.");
  await signOut(browser);

  // 19b. The account with view levels: its menu follows the levels, and view gives no add or change button.
  await browser.goto(`${API}/api/auth/sso/start?as=staf.baru`);
  check(
    "the account that got access no longer sees the waiting page",
    Boolean(await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Akun yang sedang masuk')")) &&
      !(await browser.evaluate("document.body.innerText.includes('Menunggu hak akses')")) &&
      (await browser.evaluate(`document.querySelector('[data-testid="header-identity"]').innerText.includes('Karyawan')`)),
  );
  const viewerMenu = await menuLinks(browser);
  check("its menu shows exactly the modules it may view", viewerMenu === "/ /registrasi /pos /kendaraan", viewerMenu);
  await browser.click('a[href="/kendaraan"]');
  await browser.waitFor(`location.pathname === '/kendaraan' && ${visibleRows} > 0`);
  check(
    "view level on Kendaraan shows the list without add or change buttons",
    !(await browser.evaluate("document.body.innerText.includes('Kendaraan baru')")) &&
      !(await browser.evaluate(`Boolean(document.querySelector('button[aria-label^="Ubah "]'))`)),
  );
  await browser.click('a[href="/registrasi"]');
  await browser.waitFor(`location.pathname === '/registrasi' && ${visibleRows} > 0`);
  check(
    "view level on Registrasi shows the list without add buttons",
    !(await browser.evaluate("document.body.innerText.includes('Registrasi incoming')")) &&
      !(await browser.evaluate("document.body.innerText.includes('Registrasi outgoing')")),
  );
  await browser.goto(`${WEB}/kontrak`);
  check("opening a page of a module without access shows the no-access page", Boolean(await browser.hasText("Anda tidak punya akses ke halaman ini")) && Boolean(await browser.hasText("modul Kontrak")));
  await browser.screenshot("16b-tanpa-akses-light");
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  // 19c. Beranda of a holder of the dashboard module (the local account): the live plant map instead of the stages.
  const flowBeforeMap = await stat("GET /api/trips/flow");
  await partnerSignIn(browser, "petugas.lokal");
  check(
    "Beranda of a dashboard holder shows the live plant map on the plan picture with a truck picture and count per zone, no plates on it, the trucks per zone and the control room link",
    Boolean(
      await browser.waitFor(`(() => {
        const map = document.querySelector('[data-testid="home-plant"]');
        if (!map) return false;
        const picture = map.querySelector('[data-testid="plan-image"]')?.getAttribute('href') ?? '';
        const zones = map.querySelectorAll('[data-testid="zone-counts"] li').length;
        const badges = [...map.querySelectorAll('button[data-zone-badge]')];
        const counted = badges.every((badge) => badge.querySelector('svg') && /, \\d+ truk/.test(badge.getAttribute('aria-label')) && badge.innerText.includes(badge.dataset.count));
        const noPlates = !/ZZ \\d/.test(map.querySelector('[data-testid="plant-map"]').innerText);
        const link = map.querySelector('a[href="/ruang-kontrol"]')?.innerText.includes('Buka ruang kontrol');
        return picture.startsWith('blob:') && zones === 9 && badges.length > 0 && counted && noPlates && link;
      })()`),
    ) &&
      (await browser.evaluate(`!document.querySelector('[aria-label="Truk per tahap"]') && !document.querySelector('main svg filter')`)) &&
      (await stat("GET /api/trips/flow")) === flowBeforeMap &&
      (await stat("GET /api/control-room/plan-image")) > 0,
  );
  await controlRoomKeyboard(browser, '[data-testid="home-plant"] button[data-zone-badge]', "Beranda");
  await browser.screenshot("19-beranda-denah-light");

  // 19d. The control room page itself: the Zona panel opens the same list; the wall screen lists plates per zone.
  await browser.goto(`${WEB}/ruang-kontrol`);
  await browser.waitFor(`document.querySelectorAll('[data-testid="plant-map"] button[data-zone-badge]').length > 0`);
  const panelZone = await browser.evaluate(`document.querySelector('[data-testid="zone-panel"] button[data-zone-row]')?.dataset.zoneRow ?? ''`);
  await browser.click(`[data-testid="zone-panel"] button[data-zone-row="${panelZone}"]`);
  check(
    "a row of the Zona panel opens the plates of that zone, longest wait first",
    Boolean(
      await browser.waitFor(`(() => {
        const rows = [...document.querySelectorAll('[data-testid="zone-list"] button[data-trip]')];
        const minutes = rows.map((row) => row.getAttribute('aria-label'));
        return rows.length > 0 && rows.length === Number(document.querySelector('[data-zone-badge="${panelZone}"]')?.dataset.count) && minutes.every((label) => label.includes('di zona ini'));
      })()`),
    ),
  );
  await browser.click("h1");
  check(
    "a click outside closes the zone list",
    Boolean(await browser.waitFor(`!document.querySelector('[data-testid="zone-list"]')`)),
  );
  await browser.goto(`${WEB}/layar-kontrol`);
  check(
    "the wall screen shows truck pictures and counts without buttons, and the plates per zone in its panel",
    Boolean(
      await browser.waitFor(`document.querySelectorAll('[data-testid="plant-map"] [data-zone-badge]').length > 0 &&
        document.querySelectorAll('[data-testid="plant-map"] button').length === 0 &&
        document.querySelectorAll('[data-testid="tv-zone-plates"] .plate').length > 0`),
    ),
  );
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  await phaseThree(browser);
  await phaseFour(browser);
  await decisionModules(browser);
  await phaseFive(browser);
  await historyAndVerification(browser);
  await gpsTracking(browser);
  await driverSharing(browser);
  await destinationPins(browser);
  await shipmentAndCustomer(browser);
  await millRequests(browser);
  await changeAfterSend(browser);
}

/**
 * The plant map by keyboard: Enter on a zone opens its plate list with the focus on the first plate, Enter on the
 * plate opens the truck detail window, and Escape closes each in turn with the focus going back where it came from.
 */
async function controlRoomKeyboard(browser, badgeSelector, where) {
  const zone = await browser.evaluate(`document.querySelector(${JSON.stringify(badgeSelector)}).dataset.zoneBadge`);
  await browser.evaluate(`document.querySelector(${JSON.stringify(badgeSelector)}).focus()`);
  await browser.pressEnter();
  check(
    `${where}: Enter on a zone opens its plate list with the focus on the first plate`,
    Boolean(
      await browser.waitFor(`(() => {
        const list = document.querySelector('[data-testid="zone-list"]');
        const active = document.activeElement;
        return list && list.getAttribute('role') === 'dialog' && active?.hasAttribute('data-trip') && list.contains(active) &&
          document.querySelector('[data-zone-badge="${zone}"]').getAttribute('aria-expanded') === 'true';
      })()`),
    ),
  );
  const plate = await browser.evaluate(`document.activeElement.querySelector('.plate')?.innerText ?? ''`);
  const tripsBefore = await stat("GET /api/control-room/trips/:id");
  await browser.pressEnter();
  check(
    `${where}: Enter on a plate opens the truck detail window with its papers, figures and steps, focus inside`,
    Boolean(
      await browser.waitFor(`(() => {
        const modal = document.querySelector('[data-testid="truck-modal"]');
        if (!modal || !modal.querySelector('[data-testid="truck-detail"]')) return false;
        const text = modal.innerText;
        return /detail truk/i.test(text) && modal.querySelector('[data-testid="truck-modal-plate"]').innerText === ${JSON.stringify(plate)} &&
          text.includes('Nomor SPJ') && text.includes('Supir') && text.includes('Kartu') && text.includes('Posisi sekarang') &&
          Boolean(modal.querySelector('[data-testid="truck-figures"]')) && text.includes('Langkah') && modal.contains(document.activeElement);
      })()`),
    ) && (await stat("GET /api/control-room/trips/:id")) > tripsBefore,
  );
  await browser.screenshot(`19b-detail-truk-${where.toLowerCase()}`);
  await browser.pressEscape();
  check(
    `${where}: Escape closes the detail window and gives the focus back to the plate row`,
    Boolean(
      await browser.waitFor(`!document.querySelector('[data-testid="truck-modal"]') && document.activeElement?.hasAttribute('data-trip') &&
        document.activeElement.querySelector('.plate')?.innerText === ${JSON.stringify(plate)}`),
    ),
  );
  await browser.pressEscape();
  check(
    `${where}: Escape closes the plate list and gives the focus back to the zone`,
    Boolean(await browser.waitFor(`!document.querySelector('[data-testid="zone-list"]') && document.activeElement?.dataset.zoneBadge === ${JSON.stringify(zone)}`)),
  );
}

// --- phase 3: registration, delivery order, SPJ, the post ---------------------

const noHorizontalScroll = "document.documentElement.scrollWidth <= window.innerWidth";
/** The path of the draft that got a weighbridge slip in step 22b, for the post in step 37. */
let slipRegistrationPath = null;

/** Chooses a made-up file in the file input inside `scope`, as a person picking it would. */
async function chooseFile(browser, scope, { name, type, text }) {
  await browser.waitFor(`Boolean(document.querySelector(${JSON.stringify(`${scope} input[type="file"]`)}))`);
  await browser.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(`${scope} input[type="file"]`)});
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

const PDF_TEXT = "%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n";

const textOf = (selector) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').replace(/\\s+/g, ' ')`;

async function partnerSignIn(browser, username) {
  await browser.goto(`${WEB}/login`);
  await browser.type('input[name="username"]', username);
  await browser.type('input[name="password"]', "contoh-123");
  await browser.click('button[type="submit"]');
  await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Akun yang sedang masuk')");
}

/** An access token of a partner account, through the sign-in form's route. */
async function partnerApiSession(username) {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "contoh-123" }),
  });
  return (await login.json()).accessToken;
}

/** GET on the mock as the account of `token`. */
const apiGet = async (token, route) => (await fetch(`${API}${route}`, { headers: { authorization: `Bearer ${token}` } })).json();

const bellLabelText = `document.querySelector('[data-testid="notifications-bell"]')?.getAttribute('aria-label')`;
const bellBadgeText = `(document.querySelector('[data-testid="bell-badge"]')?.innerText ?? '')`;
/** Expression: the entry of the open panel whose text contains `needle`. */
const panelEntry = (needle) =>
  `[...document.querySelectorAll('[data-testid="notifications-panel"] [data-notification]')].find((node) => node.innerText.includes(${JSON.stringify(needle)}))`;

/** The inbox of a transporter: the delivery order sent in step 23 is unread and leads to its page. */
async function transporterInbox(browser, doNo) {
  const token = await partnerApiSession("transporter.contoh");
  const unread = (await apiGet(token, "/api/notifications?unread=true&limit=1")).unreadCount;
  check(
    "the bell of a transporter says its unread count in words",
    unread >= 1 && Boolean(await browser.waitFor(`${bellLabelText} === '${unread} pemberitahuan belum dibaca' && ${bellBadgeText} === '${unread}'`)),
    `${unread} unread`,
  );
  const listsBefore = await stat("GET /api/notifications");
  await browser.click('[data-testid="notifications-bell"]');
  check(
    "opening the panel fetches the list, with the new delivery order unread and linked to its page",
    Boolean(
      await browser.waitFor(`(() => {
        const entry = ${panelEntry(doNo)};
        return Boolean(entry) && entry.innerText.includes('Delivery order baru') && entry.dataset.unread === '1' && entry.tagName === 'A' && entry.getAttribute('href').startsWith('/delivery-order/');
      })()`),
    ) && (await stat("GET /api/notifications")) > listsBefore,
  );
  check(
    "an entry of a type the web does not know is listed with its text and leads nowhere",
    Boolean(await browser.waitFor(`(() => { const entry = ${panelEntry("Jam timbang berubah")}; return Boolean(entry) && entry.tagName !== 'A' && entry.innerText.includes('kalibrasi'); })()`)),
  );
  const shown = await browser.evaluate(`document.querySelectorAll('[data-testid="notifications-panel"] [data-notification]').length`);
  await browser.click("Muat lagi");
  check(
    "Muat lagi adds the next page under the first",
    Boolean(await browser.waitFor(`document.querySelectorAll('[data-testid="notifications-panel"] [data-notification]').length > ${shown}`)),
    `${shown} first`,
  );
  await browser.screenshot("24a-lonceng-transporter-light");
  const reads = await stat("POST /api/notifications/:id/read");
  await browser.evaluate(`${panelEntry(doNo)}.setAttribute('data-smoke', 'follow'); true`);
  await browser.click('[data-smoke="follow"]');
  check(
    "following the entry opens the delivery order and marks it read",
    Boolean(await browser.waitFor(`location.pathname.startsWith('/delivery-order/') && document.body.innerText.includes(${JSON.stringify(doNo)})`)) &&
      (await waitStat("POST /api/notifications/:id/read", reads + 1)),
  );
  check(
    "the number on the bell drops by one",
    Boolean(await browser.waitFor(`${bellLabelText} === '${unread - 1 === 0 ? "Pemberitahuan, semua sudah dibaca" : `${unread - 1} pemberitahuan belum dibaca`}'`)),
  );
}

async function staffSignIn(browser, username) {
  await browser.goto(`${API}/api/auth/sso/start?as=${username}`);
  await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Akun yang sedang masuk')");
}

/** Picks the first option of any lookup after typing a part of its text. */
async function pickOption(browser, inputSelector, text) {
  await browser.type(inputSelector, text);
  await browser.waitFor(`document.querySelector('[role="option"]')?.innerText.includes(${JSON.stringify(text)})`);
  await browser.click('[role="option"]');
  await browser.waitFor(`!document.querySelector('[role="option"]')`);
}

/** Fills the plate and the licence of one truck and looks both up. `scope` is a CSS prefix for the truck. */
async function fillTruck(browser, { scope, prefix, plate, licence, newVehicle, newDriver }) {
  await browser.fill(`input[name="${prefix}.plate"]`, plate);
  await browser.click(`${scope} button[aria-label="Periksa plat"]`);
  await browser.waitFor(`${textOf(scope)}.includes(${JSON.stringify(newVehicle ? "Plat ini belum terdaftar" : "Surat kendaraan")})`);
  if (newVehicle) await browser.fill(`select[name="${prefix}.vehicleTypeCode"]`, newVehicle.type);
  await browser.fill(`input[name="${prefix}.licenceNo"]`, licence);
  await browser.click(`${scope} button[aria-label="Periksa nomor sim"]`);
  await browser.waitFor(`${textOf(scope)}.includes(${JSON.stringify(newDriver ? "Nomor SIM ini belum terdaftar" : "berlaku sampai")})`);
  if (newDriver) {
    await browser.fill(`input[name="${prefix}.fullName"]`, newDriver.fullName);
    await browser.fill(`select[name="${prefix}.licenceClass"]`, "B2 UMUM");
    await browser.fill(`input[name="${prefix}.licenceValidUntil"]`, isoDate(2));
  }
}

async function phaseThree(browser) {
  // 20. Supplier: menu, a blacklisted driver is refused, one truck with two contracts gets an SPJ.
  await partnerSignIn(browser, "pks.contoh.a");
  const supplierMenu = await menuLinks(browser);
  check(
    "a supplier gets Registrasi but not Delivery Order, Pos registrasi or Kartu RFID",
    supplierMenu.includes("/registrasi") && !["/delivery-order", "/pos", "/kartu"].some((href) => supplierMenu.includes(href)),
    supplierMenu,
  );
  await browser.click('a[href="/registrasi"]');
  await browser.waitFor("location.pathname === '/registrasi'");
  await browser.click("Registrasi incoming");
  await browser.waitFor(`document.querySelector('input[name="contractLookup"]')`);
  await pickOption(browser, 'input[name="contractLookup"]', "0123/CONTOH");
  await pickOption(browser, 'input[name="contractLookup"]', "0124/CONTOH");
  check(
    "two contracts are chosen and each gets its own letter fields",
    Boolean(await browser.waitFor(`document.querySelectorAll('[aria-label="Kontrak terpilih"] li').length === 2 && Boolean(document.querySelector('input[name="letters.1.spbNo"]'))`)),
  );
  await pickOption(browser, 'input[name="transporterLookup"]', "Contoh A");
  await fillTruck(browser, { scope: "main", prefix: "truck", plate: "zz 0001 cth", licence: "contoh0004" });
  check("a blacklisted driver is refused as soon as the licence is looked up", Boolean(await browser.hasText("Supir ini masuk daftar hitam VCF dan tidak bisa didaftarkan.")));
  await browser.click("Kirim registrasi");
  check(
    "a registration with a blacklisted driver is not sent",
    Boolean(await browser.hasText("Periksa kolom yang ditandai.")) && (await stat("POST /api/registrations")) === 0,
  );
  await browser.fill('input[name="truck.licenceNo"]', "contoh0001");
  await browser.click('main button[aria-label="Periksa nomor sim"]');
  await browser.waitFor(`${textOf("main")}.includes('Supir Contoh 01')`);
  await browser.fill('input[name="letters.0.spbNo"]', "SPB-UJI-1");
  await browser.fill('input[name="letters.0.originGrossKg"]', "30000");
  await browser.fill('input[name="letters.0.originTareKg"]', "10000");
  await browser.fill('input[name="letters.0.originNetKg"]', "19000");
  await browser.fill('input[name="letters.0.quality.FFA"]', "3,5");
  await browser.fill('input[name="letters.1.originTareKg"]', "9000");
  await browser.fill('input[name="letters.1.originNetKg"]', "5000");
  await browser.click("Kirim registrasi");
  check("net must equal gross minus tare", Boolean(await browser.hasText("Netto harus sama dengan bruto dikurangi tarra: 20.000 kg.")));
  await browser.fill('input[name="letters.0.originNetKg"]', "20000");
  check(
    "the truck weights from the letters are shown",
    Boolean(await browser.waitFor(`${textOf('[data-testid="document-totals"]')}.includes('bruto 34.000 kg, tarra 9.000 kg, netto 25.000 kg')`)),
  );
  await browser.screenshot("17-registrasi-incoming-light");
  await browser.click("Kirim registrasi");
  const supplierRegistration = await browser.waitFor("location.pathname.startsWith('/registrasi/r-') && location.pathname");
  check(
    "a supplier registers one truck with two contracts and gets an SPJ at once",
    Boolean(supplierRegistration) &&
      Boolean(await browser.hasText("Registrasi dikirim.")) &&
      Boolean(await browser.hasText("Disetujui")) &&
      Boolean(await browser.waitFor(`document.querySelectorAll('main li[data-trip-seq] a[href^="/spj/"]').length === 1`)) &&
      Boolean(await browser.hasText("0124/CONTOH/CPO/XI/2026")),
    supplierRegistration ?? "",
  );
  const supplierSpjHref = await browser.evaluate(`document.querySelector('a[aria-label="Cetak SPJ truk 1"]').getAttribute('href')`);
  await browser.screenshot("18-registrasi-detail-light");

  // 21. Print page: both barcodes, no app shell when printed, one count per print.
  await browser.goto(`${WEB}${supplierSpjHref}`);
  const barcodes = await browser.waitFor(`document.querySelector('[data-barcode="qr"] svg') && document.querySelector('[data-barcode="code128"] svg') && true`);
  const supplierToken = ((await browser.evaluate(textOf('[data-testid="spj-token"]'))) ?? "").replace(/\s+/g, "");
  check("the print page draws the QR code and the Code 128 of the token", Boolean(barcodes) && /^[0-9A-HJKMNP-TV-Z]{12}$/.test(supplierToken), supplierToken);
  const sheetText = (await browser.evaluate(textOf('[data-testid="spj-sheet"]'))) ?? "";
  check(
    "the print page shows the SPJ fields",
    ["Surat Pengantar Jalan", "SPJ/CTH/", "Supir Contoh 01", "SIM CONTOH0001", "ZZ 0001 CTH", "Transporter Contoh A", "0123/CONTOH/CPO/XI/2026", "0124/CONTOH/CPO/XI/2026", "20.000 Kg", "5.000 Kg", "PKS Contoh A", "sampai"].every((part) =>
      sheetText.includes(part),
    ),
    sheetText,
  );
  await browser.screenshot("19-spj-cetak-light");
  await browser.evaluate("window.dispatchEvent(new Event('beforeprint')); true");
  check("one print is counted once", Boolean(await browser.waitFor(`fetch('${API}/__mock/stats').then((r) => r.json()).then((s) => s.requests['POST /api/trips/:id/spj/printed'] === 1)`)));
  await browser.media("print");
  check(
    "printed, the page has no app shell and no buttons",
    await browser.evaluate(`!document.querySelector('aside') && !document.querySelector('[data-testid="header-identity"]') && !document.querySelector('nav') && [...document.querySelectorAll('button')].every((b) => b.offsetParent === null) && document.querySelector('[data-testid="spj-sheet"]').offsetParent !== null`),
  );
  await browser.screenshot("20-spj-cetak-print");
  await browser.media("");
  await browser.colorScheme("light");

  // 22. On a phone: a driver with a warning, the form has no horizontal scroll, the registration waits for review.
  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/registrasi/baru?arah=in`);
  await browser.waitFor(`document.querySelector('input[name="contractLookup"]')`);
  await pickOption(browser, 'input[name="contractLookup"]', "0123/CONTOH");
  await fillTruck(browser, { scope: "main", prefix: "truck", plate: "ZZ 0001 CTH", licence: "CONTOH0003" });
  check("a driver with a warning gets a notice but can still be registered", Boolean(await browser.hasText("Supir ini berstatus Warning di VCF.")));
  await browser.fill('input[name="letters.0.originNetKg"]', "21000");
  check("the incoming form has no horizontal scroll on a phone", await browser.evaluate(noHorizontalScroll));
  await browser.screenshot("21-registrasi-incoming-phone-light");
  await browser.click("Kirim registrasi");
  const reviewRegistration = await browser.waitFor("location.pathname.startsWith('/registrasi/r-') && location.pathname");
  check(
    "a registration with a finding waits for review",
    Boolean(reviewRegistration) && Boolean(await browser.hasText("Menunggu tinjauan")) && Boolean(await browser.hasText("Truk 1: Supir berstatus Warning di VCF.")),
  );
  check("the registration detail has no horizontal scroll on a phone", await browser.evaluate(noHorizontalScroll));
  await browser.viewport(1366, 900);

  // 22b. A draft is opened again in its form, looked up again, changed and sent with PUT.
  await browser.goto(`${WEB}/registrasi/baru?arah=in`);
  await browser.waitFor(`document.querySelector('input[name="contractLookup"]')`);
  await pickOption(browser, 'input[name="contractLookup"]', "0124/CONTOH");
  await fillTruck(browser, { scope: "main", prefix: "truck", plate: "ZZ 0001 CTH", licence: "CONTOH0002" });
  await browser.fill('input[name="letters.0.originNetKg"]', "1000");
  await chooseFile(browser, '[data-testid="form-slips"]', { name: "slip.docx", type: "application/msword", text: "bukan slip" });
  check("the form refuses a file that is not a PDF or a picture", Boolean(await browser.hasText("Pilih berkas PDF atau gambar JPEG, PNG, atau WebP.")));
  await chooseFile(browser, '[data-testid="form-slips"]', { name: "slip-pks.pdf", type: "application/pdf", text: PDF_TEXT });
  check(
    "a weighbridge slip is uploaded on the form and waits for the save",
    Boolean(await browser.waitFor(`${textOf('[data-testid="form-slips"]')}.includes('slip-pks.pdf')`)) && (await stat("POST /api/files")) === 1,
  );
  await browser.click("Simpan draf");
  const draftPath = await browser.waitFor("location.pathname.startsWith('/registrasi/r-') && location.pathname");
  check("a registration is saved as a draft", Boolean(draftPath) && Boolean(await browser.hasText("Registrasi disimpan sebagai draf.")));
  check(
    "the slip is linked to the truck of the draft and listed in the detail",
    Boolean(await browser.waitFor(`${textOf('[data-testid="trip-slips-1"]')}.includes('slip-pks.pdf')`)) &&
      (await stat("POST /api/registrations/:id/trips/:tripId/files")) === 1,
  );
  slipRegistrationPath = draftPath;
  await browser.click("Ubah draf");
  check(
    "the draft opens in its form with the contract, the truck looked up again and the letter",
    Boolean(await browser.waitFor(`location.pathname.endsWith('/ubah') && document.querySelectorAll('[aria-label="Kontrak terpilih"] li').length === 1`)) &&
      Boolean(await browser.waitFor(`${textOf("main")}.includes('Surat kendaraan') && ${textOf("main")}.includes('Supir Contoh 02')`)) &&
      (await browser.evaluate(`document.querySelector('input[name="letters.0.originNetKg"]').value === '1000'`)),
  );
  check("the draft form lists the slip it already has", Boolean(await browser.waitFor(`${textOf('[data-testid="form-slips"]')}.includes('slip-pks.pdf')`)));
  await browser.fill('input[name="letters.0.originNetKg"]', "1500");
  await browser.click("Kirim registrasi");
  check(
    "the changed draft is sent with PUT and gets its SPJ",
    Boolean(await browser.waitFor(`location.pathname === ${JSON.stringify(draftPath)}`)) &&
      Boolean(await browser.hasText("Registrasi dikirim.")) &&
      Boolean(await browser.hasText("Netto asal 1.500 kg")) &&
      (await stat("PUT /api/registrations/:id")) === 1,
  );
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  // 23. Logistics admin: approves, creates and sends a delivery order, registers an RFID card.
  await staffSignIn(browser, "admin.contoh");
  await browser.goto(`${WEB}${reviewRegistration}`);
  await browser.click("Setujui");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "an admin approves the registration and the SPJ is issued",
    Boolean(await browser.hasText("Registrasi disetujui. SPJ sudah terbit.")) && Boolean(await browser.waitFor(`document.querySelectorAll('a[href^="/spj/"]').length === 1`)),
  );

  await browser.click('a[href="/delivery-order"]');
  await browser.waitFor(`location.pathname === '/delivery-order' && ${visibleRows} > 0`);
  await browser.click("DO baru");
  await pickOption(browser, inSheet('input[name="contractLookup"]'), "0045/CONTOH");
  await browser.fill(inSheet('input[name="destName"]'), "Gudang Uji Ketik");
  await browser.fill(inSheet('textarea[name="destAddress"]'), "Jalan Uji No. 2");
  await browser.fill(inSheet('input[name="destDistrict"]'), "Kecamatan Uji");
  await browser.fill(inSheet('input[name="destRegency"]'), "Kota Uji");
  await browser.fill(inSheet('input[name="destProvince"]'), "Provinsi Uji");
  await browser.fill(inSheet('input[name="qty"]'), "38002");
  await pickOption(browser, inSheet('input[name="transporterLookup"]'), "Contoh A");
  await browser.screenshot("22-do-form-light");
  await browser.click(inSheet('button[type="submit"]'));
  const created = (await browser.waitFor(`[...document.querySelectorAll('p')].find((p) => p.innerText.includes('dibuat sebagai draf'))?.innerText`)) ?? "";
  const doNo = /DO (\S+) dibuat/.exec(created)?.[1] ?? "";
  check("a delivery order made from a contract gets a generated number", /^\d{3}\/DO\/CTH\/[IVX]+\/\d{4}$/.test(doNo), doNo);
  check("the new delivery order is listed as draft with its customer", (await browser.evaluate(rowText(doNo))).includes("Customer Contoh A") && (await browser.evaluate(rowText(doNo))).includes("Draf"));
  await browser.click(`button[aria-label="Tindakan ${doNo}"]`);
  await browser.click("Kirim DO");
  check(
    "the send sheet starts on Transporter with the transporter of the DO chosen",
    Boolean(
      await browser.waitFor(
        `[...document.querySelectorAll('[role="dialog"] button[aria-pressed="true"]')].some((button) => button.innerText.trim() === 'Transporter') && ((document.querySelector('[role="dialog"]')?.innerText ?? '') + ' ' + [...document.querySelectorAll('[role="dialog"] input')].map((input) => input.value).join(' ')).includes('Transporter Contoh A')`,
      ),
    ),
  );
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "the delivery order is sent to the transporter",
    Boolean(await browser.hasText(`DO ${doNo} dikirim ke Transporter Contoh A.`)) &&
      Boolean(await browser.waitFor(`${rowText(doNo)}.includes('Menunggu diterima') && ${rowText(doNo)}.includes('Transporter: Transporter Contoh A')`)),
  );
  await browser.screenshot("23-do-admin-light");

  await browser.click('a[href="/kartu"]');
  check("/kartu lists the RFID cards", (await browser.waitFor(`location.pathname === '/kartu' && ${visibleRows}`)) === 7);
  await browser.click("Kartu baru");
  await browser.fill(inSheet('input[name="uid"]'), "04:a1:b2:c3:99");
  await browser.fill(inSheet('input[name="label"]'), "Kartu Uji");
  await browser.click(inSheet('button[type="submit"]'));
  check("a new card is saved with its UID normalised", Boolean(await browser.hasText("Kartu 04A1B2C399 ditambahkan.")) && Boolean(await browser.waitFor(`${rowText("04A1B2C399")}.includes('Tersedia')`)));
  await browser.click("Kartu baru");
  await browser.fill(inSheet('input[name="uid"]'), "04a1b2c301");
  await browser.click(inSheet('button[type="submit"]'));
  check("a UID that is already registered is refused", Boolean(await browser.hasText("UID kartu ini sudah terdaftar.")));
  await browser.click("Batal");
  await browser.screenshot("24-kartu-light");
  await signOut(browser);

  // 24. Transporter: accepts with a truck count, fills four trucks, sees the split.
  await partnerSignIn(browser, "transporter.contoh");
  const transporterMenu = await menuLinks(browser);
  check(
    "a transporter gets Delivery Order and Registrasi but not the post",
    transporterMenu.includes("/delivery-order") && transporterMenu.includes("/registrasi") && !transporterMenu.includes("/pos"),
    transporterMenu,
  );
  await transporterInbox(browser, doNo);
  await browser.click('a[href="/delivery-order"]');
  await browser.waitFor(`${rowText(doNo)} !== ''`);
  check("the transporter sees only its own delivery orders, none in draft", (await browser.evaluate(visibleRows)) === 2 && !(await browser.evaluate(`document.querySelector('tbody').innerText.includes('Draf')`)));
  await browser.click(`button[aria-label="Terima ${doNo}"]`);
  await browser.fill(inSheet('input[name="truckCount"]'), "4");
  await browser.click(inSheet('button[type="submit"]'));
  check("the transporter accepts and gives the truck count", Boolean(await browser.hasText(`DO ${doNo} diterima.`)) && Boolean(await browser.waitFor(`${rowText(doNo)}.includes('0 dari 4')`)));
  await browser.click(`a[aria-label="Isi daftar truk ${doNo}"]`);
  await browser.waitFor(`document.querySelectorAll('[data-truck]').length === 4`);
  const splitText = textOf('[data-testid="split-summary"]');
  check("four trucks start from the truck count, with the split shown", (await browser.evaluate(splitText)).includes("9.500 kg per truk, truk terakhir 9.502 kg"));
  await browser.click("Tambah truk");
  check("adding a truck changes the split", Boolean(await browser.waitFor(`${splitText}.includes('7.600 kg per truk, truk terakhir 7.602 kg')`)));
  await browser.click('button[aria-label="Hapus truk 5"]');
  check("removing it gives the first split back", Boolean(await browser.waitFor(`${splitText}.includes('9.500 kg per truk, truk terakhir 9.502 kg') && document.querySelectorAll('[data-truck]').length === 4`)));
  await fillTruck(browser, { scope: '[data-truck="1"]', prefix: "trucks.0", plate: "ZZ 0001 CTH", licence: "CONTOH0001" });
  await fillTruck(browser, { scope: '[data-truck="2"]', prefix: "trucks.1", plate: "ZZ 0002 CTH", licence: "CONTOH0002" });
  await fillTruck(browser, {
    scope: '[data-truck="3"]',
    prefix: "trucks.2",
    plate: "ZZ 9101 UJI",
    licence: "UJI9101",
    newVehicle: { type: "TANGKI" },
    newDriver: { fullName: "Supir Uji Tiga" },
  });
  await fillTruck(browser, { scope: '[data-truck="4"]', prefix: "trucks.3", plate: "ZZ 9102 UJI", licence: "CONTOH0006", newVehicle: { type: "TANGKI" } });
  check(
    "the transporter's outgoing form asks neither close cargo nor flexi bag (the post marks them at check-in)",
    !(await browser.evaluate(`Boolean(document.querySelector('input[name="closeCargo"], input[name="flexiBag"]'))`)),
  );
  await browser.screenshot("25-registrasi-outgoing-light");
  await browser.click("Kirim registrasi");
  const outgoingRegistration = await browser.waitFor("location.pathname.startsWith('/registrasi/r-') && location.pathname");
  check(
    "four trucks are submitted and wait for review because of their findings",
    Boolean(outgoingRegistration) &&
      Boolean(await browser.hasText("Menunggu tinjauan")) &&
      Boolean(await browser.waitFor(`document.querySelectorAll('li[data-trip-seq]').length === 4`)) &&
      Boolean(await browser.hasText("KIR kendaraan sudah lewat masa berlaku.")),
  );
  await signOut(browser);

  // 25. The admin approves: four SPJ with the split quantities.
  await staffSignIn(browser, "admin.contoh");
  await browser.goto(`${WEB}${outgoingRegistration}`);
  await browser.click("Setujui");
  await browser.click(inSheet('button[type="submit"]'));
  await browser.hasText("Registrasi disetujui. SPJ sudah terbit.");
  const plans = await browser.evaluate(`[...document.querySelectorAll('li[data-trip-seq]')].map((li) => {
    const text = li.innerText.replace(/\\s+/g, ' ');
    return (/Rencana quantity ([\\d.]+) Kg/.exec(text) ?? [])[1] + (li.querySelector('a[href^="/spj/"]') ? ' SPJ' : '');
  }).join(', ')`);
  check("four SPJ exist with the split quantities", plans === "9.500 SPJ, 9.500 SPJ, 9.500 SPJ, 9.502 SPJ", plans);
  await browser.click('a[href="/delivery-order"]');
  check("the delivery order shows four trucks and nothing left", Boolean(await browser.waitFor(`${rowText(doNo)}.includes('4 dari 4') && ${rowText(doNo)}.includes('Sisa 0 Kg')`)));
  await browser.click(doNo);
  check(
    "the delivery order page lists its four trucks with their SPJ",
    Boolean(await browser.waitFor(`location.pathname.startsWith('/delivery-order/') && [...document.querySelectorAll('[data-testid="do-trucks"] tbody tr')].length === 4`)) &&
      Boolean(await browser.waitFor(`${textOf('[data-testid="do-trucks"]')}.includes('ZZ 9101 UJI') && ${textOf('[data-testid="do-trucks"]')}.includes('SPJ/CTH/')`)),
  );
  await browser.screenshot("25b-do-detail-light");
  await signOut(browser);

  // 26. The post: scan plus card, a second scan refused, an unknown card refused, replace a card.
  await staffSignIn(browser, "pos.contoh");
  await browser.click('a[href="/pos"]');
  await browser.waitFor(`location.pathname === '/pos' && document.activeElement?.id === 'gate-scan'`);
  check("the scan box has focus when the post opens", (await browser.evaluate("document.activeElement?.id")) === "gate-scan");
  check(
    "today's expected trucks are listed",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gate-upcoming"]')}.includes('ZZ 9101 UJI') && ${textOf('[data-testid="gate-upcoming"]')}.includes('ZZ 0001 CTH')`)),
  );
  await browser.typeFocused(supplierToken.toLowerCase());
  await browser.pressEnter();
  check(
    "a scan shows the truck and moves focus to the card box",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gate-truck"]')}.includes('ZZ 0001 CTH') && document.activeElement?.id === 'gate-card'`)),
  );
  await browser.screenshot("26-pos-scan-light");
  await browser.typeFocused("04:a1:b2:c3:01");
  await browser.pressEnter();
  check(
    "the card checks the truck in and focus returns to the scan box",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gate-success"]')}.includes('Check-in berhasil') && document.activeElement?.id === 'gate-scan'`)) &&
      Boolean(await browser.waitFor(`${textOf('[data-testid="gate-inside"]')}.includes('ZZ 0001 CTH')`)),
  );
  await browser.screenshot("27-pos-success-light");
  await browser.typeFocused(supplierToken);
  await browser.pressEnter();
  check(
    "a second scan of the same SPJ is refused and asks for no card",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gate-blocks"]')}.includes('Truk ini sudah check-in.')`)) &&
      !(await browser.evaluate("Boolean(document.querySelector('#gate-card'))")) &&
      (await browser.evaluate("document.activeElement?.id")) === "gate-scan",
  );
  await browser.typeFocused("AAAAAAAAAAAA");
  await browser.pressEnter();
  check("an unknown SPJ is refused in plain words", Boolean(await browser.hasText("Kode SPJ ini tidak dikenal.")));
  await browser.click('button[aria-label="Periksa ZZ 9101 UJI"]');
  check(
    "a bulk outgoing truck the transporter registered asks the post for close cargo and flexi bag before the card",
    Boolean(
      await browser.waitFor(
        `Boolean(document.querySelector('[data-testid="gate-marks"]')) && !document.querySelector('#gate-card') && document.activeElement?.name === 'closeCargo' && !document.querySelector('[data-testid="gate-marks"] input:checked')`,
      ),
    ),
  );
  await browser.click('[data-testid="gate-marks"] label:has(input[name="closeCargo"][value="yes"])');
  await browser.click('[data-testid="gate-marks"] label:has(input[name="flexiBag"][value="no"])');
  await browser.waitFor("document.activeElement?.id === 'gate-card'");
  check(
    "a warning is shown apart from blocking checks",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gate-warnings"]')}.includes('Kendaraan baru dan belum diverifikasi admin.') && !document.querySelector('[data-testid="gate-blocks"]')`)),
  );
  await browser.typeFocused("deadbeef");
  await browser.pressEnter();
  check(
    "an unknown card is refused and the card box stays ready",
    Boolean(await browser.hasText("Kartu ini belum terdaftar.")) && (await browser.evaluate("document.activeElement?.id")) === "gate-card",
  );
  await browser.screenshot("28-pos-card-refused-light");
  await browser.pressEscape();
  check("Escape leaves the card box for the scan box", Boolean(await browser.waitFor("document.activeElement?.id === 'gate-scan' && !document.querySelector('#gate-card')")));
  await browser.click('button[aria-label="Ganti kartu ZZ 0001 CTH"]');
  await browser.fill(inSheet('select[name="replaceReason"]'), "LOST");
  await browser.fill(inSheet('input[name="replaceCardUid"]'), "04a1b2c303");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "a lost card is replaced and focus returns to the scan box",
    Boolean(await browser.hasText("diganti dengan Kartu 03")) && Boolean(await browser.waitFor("document.activeElement?.id === 'gate-scan'")),
  );
  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/pos`);
  await browser.waitFor(`${textOf('[data-testid="gate-inside"]')}.includes('ZZ 0001 CTH')`);
  check("the post has no horizontal scroll on a phone", await browser.evaluate(noHorizontalScroll));
  await browser.screenshot("29-pos-phone-light");
  await browser.viewport(1366, 900);
  await browser.goto(`${WEB}/`);
  await signOut(browser);
}

// --- phase 4: stations, decisions, the bell, truck steps, card return, reports ----

async function phaseFour(browser) {
  // 27. An account without the modules of phase 4: no bell, no access to the reports.
  await staffSignIn(browser, "pos.contoh");
  check(
    "an account without approvals gets the bell of its unread notifications, not of the requests waiting",
    Boolean(await browser.waitFor(`document.querySelector('[data-testid="notifications-bell"]')?.dataset.mode === 'unread' && ${bellLabelText} === '1 pemberitahuan belum dibaca'`)),
  );
  await browser.goto(`${WEB}/laporan`);
  check("/laporan refuses an account without the reports module", Boolean(await browser.hasText("Anda tidak punya akses ke halaman ini")) && (await stat("GET /api/reports/contracts")) === 0);
  await browser.goto(`${WEB}/riwayat`);
  check("/riwayat refuses an account without the reports module", Boolean(await browser.hasText("Anda tidak punya akses ke halaman ini")) && (await stat("GET /api/history/trips")) === 0);
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  // 28. The bell of a holder of approvals counts the requests waiting.
  await staffSignIn(browser, "admin.contoh");
  const adminToken = await apiSession("admin.contoh");
  const waitingNow = (await apiGet(adminToken, "/api/exceptions?status=PENDING&limit=50")).items.length;
  const adminUnread = (await apiGet(adminToken, "/api/notifications?unread=true&limit=1")).unreadCount;
  check(
    "the bell shows the number of requests waiting, not the unread count",
    waitingNow === 4 &&
      adminUnread !== waitingNow &&
      Boolean(
        await browser.waitFor(
          `document.querySelector('[data-testid="notifications-bell"]')?.dataset.mode === 'approvals' && ${bellLabelText} === '${waitingNow} permintaan menunggu keputusan' && ${bellBadgeText} === '${waitingNow}'`,
        ),
      ),
    `${waitingNow} waiting, ${adminUnread} unread`,
  );
  await browser.click('[data-testid="notifications-bell"]');
  check(
    "the bell lists the waiting requests and its first line leads to Keputusan",
    Boolean(
      await browser.waitFor(`(() => {
        const first = document.querySelector('[data-testid="notifications-panel"] [data-testid="bell-decisions"]');
        const entry = ${panelEntry("Selisih bruto menunggu keputusan")};
        return first?.getAttribute('href') === '/keputusan' && first.innerText.replace(/\\s+/g, ' ').includes('${waitingNow} permintaan menunggu keputusan') &&
          Boolean(entry) && entry.innerText.includes('Menunggu keputusan') && entry.getAttribute('href')?.startsWith('/keputusan?permintaan=');
      })()`),
    ),
  );
  check(
    "a request decided since says so",
    Boolean(await browser.waitFor(`(${panelEntry("Selisih netto menunggu keputusan")})?.innerText.includes('Sudah diputuskan: disetujui')`)),
  );
  const adminReads = await stat("POST /api/notifications/:id/read");
  await browser.evaluate(`${panelEntry("Selisih bruto menunggu keputusan")}.setAttribute('data-smoke', 'follow'); true`);
  await browser.click('[data-smoke="follow"]');
  check(
    "following a request opens it on Keputusan and marks it read",
    Boolean(await browser.waitFor(`location.pathname === '/keputusan' && location.search.startsWith('?permintaan=') && Boolean(document.querySelector('[data-testid="approval-decide"]'))`)) &&
      (await waitStat("POST /api/notifications/:id/read", adminReads + 1)) &&
      (await apiGet(adminToken, "/api/notifications?unread=true&limit=1")).unreadCount === adminUnread - 1,
  );
  check(
    "after reading, the number on the bell is still the requests waiting",
    Boolean(await browser.waitFor(`${bellLabelText} === '${waitingNow} permintaan menunggu keputusan'`)),
  );
  await browser.pressEscape();
  check("closing the request takes it out of the address bar", Boolean(await browser.waitFor(`!document.querySelector('[role="dialog"]') && location.search === ''`)));

  // 29. Stasiun: list, a new weighbridge, its machine key shown once.
  await browser.click('a[href="/stasiun"]');
  check("/stasiun lists the stations", Boolean(await browser.waitFor(`location.pathname === '/stasiun' && ${rowText("WB-1")}.includes('Ada')`)));
  await browser.click("Stasiun baru");
  await browser.fill(inSheet('input[name="code"]'), "");
  await browser.click(inSheet('button[type="submit"]'));
  check("the station form asks for the code and the name", Boolean(await browser.hasText("Isi kode.")) && Boolean(await browser.hasText("Isi nama.")) && (await stat("POST /api/stations")) === 0);
  await browser.fill(inSheet('input[name="code"]'), "wb-9");
  await browser.fill(inSheet('input[name="name"]'), "Timbangan Uji");
  await browser.fill(inSheet('input[name="cameraWeigh1"]'), "5");
  await browser.fill(inSheet('input[name="cameraWeigh2"]'), "6");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "a new weighbridge is saved with its cameras",
    Boolean(await browser.hasText("Stasiun WB-9 ditambahkan.")) && Boolean(await browser.waitFor(`${rowText("WB-9")}.includes('Kamera 5 dan 6') && ${rowText("WB-9")}.includes('Belum ada')`)),
  );
  await browser.click('button[aria-label="Buat kunci mesin WB-9"]');
  await browser.waitFor(`Boolean(document.querySelector('[data-testid="station-key-dialog"]'))`);
  await browser.click("Buat kunci mesin");
  check(
    "the machine key is shown once, with the warning",
    Boolean(await browser.waitFor(`(document.querySelector('[data-testid="station-key"]')?.value ?? '').length > 20`)) &&
      Boolean(await browser.hasText("hanya ditampilkan sekali")) &&
      (await stat("POST /api/stations/:id/key")) === 1,
  );
  await browser.screenshot("30-stasiun-kunci-light");
  await browser.click("Sudah disimpan");
  check("after the dialog the station shows that it has a key", Boolean(await browser.waitFor(`!document.querySelector('[data-testid="station-key-dialog"]') && ${rowText("WB-9")}.includes('Ada')`)));

  // 30. Keputusan: the list, a reason that is required, a decision, a refusal of the server.
  await browser.click('a[href="/keputusan"]');
  check(
    "/keputusan lists the requests waiting, the QC hold included",
    Boolean(await browser.waitFor(`location.pathname === '/keputusan' && ${visibleRows} === 4 && ${rowText("Tahan QC")} !== ''`)),
  );
  check(
    "a request shows the plate read by the camera next to the registered plate",
    (await browser.evaluate(rowText("Plat tidak cocok"))).includes("Kamera: ZZ0002CTN") && (await browser.evaluate(rowText("Selisih bruto"))).includes("dari toleransi"),
  );
  const listCalls = await stat("GET /api/exceptions");
  await sleep(5600);
  check("the list refreshes by itself while the tab is visible", (await stat("GET /api/exceptions")) > listCalls);
  await browser.click('button[aria-label^="Rincian Selisih bruto"]');
  await browser.waitFor(`Boolean(document.querySelector('[data-testid="approval-decide"]'))`);
  const decideButtons = await browser.evaluate(`[...document.querySelectorAll('[data-testid="approval-decide"] button')].map((button) => button.innerText.trim()).join(' | ')`);
  check("a request at the first weighing offers Setujui, Mundur/hold and Tolak truk", decideButtons === "Setujui | Mundur/hold | Tolak truk", decideButtons);
  await browser.click("Tolak truk");
  check(
    "turning the truck away needs a reason before it is sent",
    Boolean(await browser.waitFor(`${textOf('[data-testid="approval-decide"]')}.includes('Isi alasan')`)) && (await stat("POST /api/exceptions/:id/decide")) === 0,
  );
  await browser.click("Setujui");
  check("a weight difference needs a reason before it is sent", Boolean(await browser.hasText("Isi alasan, minimal 3 huruf.")) && (await stat("POST /api/exceptions/:id/decide")) === 0);
  await browser.fill(inSheet('textarea[name="decisionReason"]'), "Selisih karena hujan (uji)");
  await browser.click("Setujui");
  check(
    "the approval saves the weighing with a Berita Acara",
    Boolean(await browser.waitFor(`(document.querySelector('[data-testid="approval-outcome"]')?.innerText ?? '').includes('Keputusan: Disetujui') && document.querySelector('[data-testid="approval-outcome"]').innerText.includes('BA-SELISIH-BRUTO')`)),
  );
  check(
    "an approved request with a Berita Acara links to its print page",
    Boolean(await browser.waitFor(`(document.querySelector('[data-testid="report-print-link"]')?.getAttribute('href') ?? '').startsWith('/berita-acara/')`)),
  );
  await browser.pressEscape();
  await browser.waitFor(`!document.querySelector('[role="dialog"]') && ${visibleRows} === 3`);

  await browser.click('button[aria-label^="Rincian Selisih tarra"]');
  await browser.waitFor(`Boolean(document.querySelector('[data-testid="approval-decide"]'))`);
  check("the tare difference offers to make the weight the master tare", Boolean(await browser.waitFor(`Boolean(document.querySelector('[role="dialog"] input[name="updateMasterTare"]'))`)));
  const tare = (await (await fetch(`${API}/api/exceptions?status=PENDING&type=TARE_OUT`, { headers: { authorization: `Bearer ${await apiSession("admin.contoh")}` } })).json()).items[0];
  await fetch(`${API}/api/exceptions/${tare.id}/decide`, {
    method: "POST",
    headers: { authorization: `Bearer ${await apiSession("admin.contoh")}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "HOLD", reason: "Diputuskan di tempat lain (uji)" }),
  });
  await browser.fill(inSheet('textarea[name="decisionReason"]'), "Tarra sesuai (uji)");
  await browser.click("Setujui");
  check(
    "a request decided elsewhere is refused in plain words and shows its decision",
    Boolean(await browser.waitFor(`(document.querySelector('[data-testid="approval-refusal"]')?.innerText ?? '').includes('sudah diputuskan orang lain')`)) &&
      Boolean(await browser.waitFor(`(document.querySelector('[data-testid="approval-outcome"]')?.innerText ?? '').includes('Keputusan: Mundur/hold')`)),
  );
  await browser.screenshot("31-keputusan-ditolak-server-light");
  await browser.pressEscape();

  // 31. Truck detail at the post: steps, weighings, the temporary step button; then the card comes back.
  await browser.click('a[href="/pos"]');
  await browser.waitFor(`${textOf('[data-testid="gate-inside"]')}.includes('ZZ 0003 CTH')`);
  await browser.click('button[aria-label="Rincian ZZ 0003 CTH"]');
  check(
    "the truck detail shows the steps and the weighing",
    Boolean(await browser.waitFor(`${textOf('[data-testid="trip-work"]')}.includes('Timbang 1 (bruto)') && ${textOf('[data-step="QC"]')}.includes('Siap')`)),
  );
  await browser.click(inSheet('[data-testid="temporary-step"] button'));
  check(
    "a holder of the step's module completes it, and the next step is ready",
    Boolean(await browser.waitFor(`${textOf('[data-step="QC"]')}.includes('Selesai') && ${textOf('[data-step="UNLOADING"]')}.includes('Siap')`)) &&
      (await stat("POST /api/trips/:id/steps/:stepCode/complete")) === 1,
  );
  await browser.pressEscape();
  await browser.waitFor(`!document.querySelector('[role="dialog"]')`);
  await browser.click("Kembalikan kartu");
  check("the card return box has focus", Boolean(await browser.waitFor("document.activeElement?.id === 'gate-checkout'")));
  await browser.typeFocused("04a1b2c303");
  await browser.pressEnter();
  check(
    "a truck that has not reached the exit cannot return its card",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gate-checkout-refused"]')}.includes('Truk belum sampai langkah keluar')`)) &&
      Boolean(await browser.waitFor("document.activeElement?.id === 'gate-checkout'")),
  );
  await browser.typeFocused("04A1B2C305");
  await browser.pressEnter();
  check(
    "the card of a truck at the exit comes back",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gate-checkout-done"]')}.includes('Kartu kembali') && ${textOf('[data-testid="gate-checkout-done"]')}.includes('ZZ 0004 CTH')`)),
  );
  check("the post has no horizontal scroll with the card return", await browser.evaluate(noHorizontalScroll));

  // 32. The truck detail in the registration.
  await browser.goto(`${WEB}/registrasi`);
  await browser.waitFor(visibleRows);
  const seeded = await browser.evaluate(`[...document.querySelectorAll('tbody tr')].find((row) => row.offsetParent !== null && row.innerText.includes('PKS Contoh B') && row.innerText.includes('0124/CONTOH'))?.querySelector('a')?.getAttribute('href') ?? ''`);
  await browser.goto(`${WEB}${seeded}`);
  await browser.click('button[aria-label="Langkah dan timbang truk 1"]');
  check(
    "the registration shows the weighings and the split per contract",
    Boolean(await browser.waitFor(`${textOf('[data-testid="trip-work"]')}.includes('Pembagian netto') && ${textOf('[data-testid="trip-work"]')}.includes('0124/CONTOH/CPO/XI/2026')`)),
  );

  // 33. Laporan: both reports, and the CSV.
  await browser.click('a[href="/laporan"]');
  check("/laporan shows the realisation per contract", Boolean(await browser.waitFor(`location.pathname === '/laporan' && ${visibleRows} > 0 && ${rowText("0125/CONTOH")} !== ''`)));
  check(
    "by default only contracts that moved are listed, and the header counts them",
    !(await browser.evaluate("document.body.innerText.includes('ZZ-SEPI-')")) && Boolean(await browser.hasText("kontrak bergerak")) && Boolean(await browser.hasText("truk selesai")),
  );
  await browser.click('button[role="switch"]');
  check(
    "the switch lists every contract, 50 per page, and goes into the address",
    Boolean(await browser.waitFor(`${visibleRows} === 50 && /^1–50 dari \\d+ kontrak$/.test(${textOf('[data-testid="pager"] [role="status"]')}) && new URLSearchParams(location.search).get('all') === '1'`)),
  );
  await browser.click("Berikutnya");
  check(
    "the next page shows the following rows and keeps its number in the address",
    Boolean(await browser.waitFor(`/^51–\\d+ dari \\d+ kontrak$/.test(${textOf('[data-testid="pager"] [role="status"]')}) && new URLSearchParams(location.search).get('page') === '2'`)),
  );
  await browser.goto(`${WEB}/laporan${await browser.evaluate("location.search")}`);
  check(
    "a reload keeps the page and the switch",
    Boolean(await browser.waitFor(`/^51–/.test(${textOf('[data-testid="pager"] [role="status"]')}) && document.querySelector('button[role="switch"]')?.getAttribute('aria-checked') === 'true'`)),
  );
  await browser.click("Sebelumnya");
  check("the previous page goes back to the first rows", Boolean(await browser.waitFor(`/^1–50 /.test(${textOf('[data-testid="pager"] [role="status"]')}) && !new URLSearchParams(location.search).has('page')`)));
  await browser.click('button[role="switch"]');
  await browser.waitFor(`!new URLSearchParams(location.search).has('all')`);
  await browser.click("Per truk");
  check("the trip report lists the weighed trucks", Boolean(await browser.waitFor(`${rowText("ZZ0004CTH")}.includes('24.020 kg') || ${rowText("ZZ0004CTH")}.includes('15.020 kg')`)));
  const searchesBefore = await stat("GET /api/reports/trips");
  await browser.type('input[type="search"]', "zz 0004", { perKey: true });
  check(
    "the truck search goes to the server, plate typed with a space",
    Boolean(await browser.waitFor(`${visibleRows} > 0 && [...document.querySelectorAll('tbody tr')].every((row) => row.innerText.includes('ZZ0004CTH')) && new URLSearchParams(location.search).get('q') === 'zz 0004'`)) &&
      (await stat("GET /api/reports/trips")) > searchesBefore,
  );
  await browser.fill('input[type="search"]', "");
  await browser.waitFor(`!new URLSearchParams(location.search).has('q')`);
  // the cleared search reaches the server after the debounce; count the CSV request only after that one
  await sleep(800);
  const csvBefore = await stat("GET /api/reports/trips");
  await browser.click("Unduh CSV");
  await sleep(800);
  check(
    "the CSV is fetched with the session and no error is shown",
    (await stat("GET /api/reports/trips")) === csvBefore + 1 && !(await browser.evaluate("document.body.innerText.includes('CSV belum bisa diunduh')")),
  );
  // 34. List filters live in the address bar; the vehicle table fits without scrolling.
  await browser.goto(`${WEB}/registrasi?status=SUBMITTED`);
  check(
    "a list opened with a filter in the address applies it",
    // every registration of this run has been reviewed by now, so the filtered list is empty
    Boolean(await browser.waitFor(`document.querySelector('select[name="statusFilter"]')?.value === 'SUBMITTED' && document.body.innerText.includes('Tidak ada registrasi yang cocok')`)),
  );
  await browser.fill('select[name="directionFilter"]', "IN");
  check("changing a filter writes it to the address", Boolean(await browser.waitFor("location.search.includes('arah=IN') && location.search.includes('status=SUBMITTED')")));
  await browser.goto(`${WEB}/kendaraan`);
  await browser.waitFor(`${visibleRows} > 0`);
  check(
    "the vehicle table fits a desktop screen without scrolling",
    await browser.evaluate(`[...document.querySelectorAll('[data-slot="table-container"]')].every((box) => box.offsetParent === null || box.scrollWidth <= box.clientWidth)`),
  );
  await browser.viewport(390, 844, true);
  for (const page of ["/keputusan", "/stasiun", "/laporan"]) {
    await browser.goto(`${WEB}${page}`);
    await browser.waitFor("document.querySelector('main h1')");
    await sleep(400);
    check(`${page} has no horizontal scroll on a phone`, await browser.evaluate(noHorizontalScroll));
  }
  await browser.viewport(1366, 900);
  await browser.goto(`${WEB}/`);
  await signOut(browser);
}

// --- the two decision modules: approvals for the weighbridge requests, qc_approvals for the QC holds ----

async function decisionModules(browser) {
  const adminToken = await apiSession("admin.contoh");
  const [qcHold] = (await apiGet(adminToken, "/api/exceptions?status=PENDING&type=QC_HOLD")).items;
  const decisionButton = (label) => `(document.querySelector('button[aria-label^="Rincian ${label}"]')?.innerText ?? '')`;

  // 31a. Weighbridge only: the API hides the QC holds from it, in the list and in the detail.
  const weighbridgeToken = await apiSession("keputusan.timbang");
  const weighbridgeList = (await apiGet(weighbridgeToken, "/api/exceptions?limit=50")).items;
  const hiddenDetail = await fetch(`${API}/api/exceptions/${qcHold?.id}`, { headers: { authorization: `Bearer ${weighbridgeToken}` } });
  check(
    "the API hides the QC holds from an account without qc_approvals",
    Boolean(qcHold) && weighbridgeList.length > 0 && weighbridgeList.every((item) => item.type !== "QC_HOLD") && hiddenDetail.status === 404,
    `${weighbridgeList.length} listed, detail ${hiddenDetail.status}`,
  );
  await staffSignIn(browser, "keputusan.timbang");
  await browser.click('a[href="/keputusan"]');
  check(
    "a weighbridge-only account lists the plate request to decide and no QC hold",
    Boolean(await browser.waitFor(`location.pathname === '/keputusan' && ${visibleRows} === 1 && ${decisionButton("Plat tidak cocok")}.includes('Putuskan') && ${rowText("Tahan QC")} === ''`)),
  );
  await browser.goto(`${WEB}/keputusan?permintaan=${encodeURIComponent(qcHold?.id ?? "")}`);
  check(
    "a QC hold opened by its address is not found for it, and shows no decision controls",
    Boolean(await browser.waitFor(`(document.querySelector('[role="dialog"]')?.innerText ?? '').includes('kode 404')`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="approval-decide"]'))`)),
  );
  await browser.pressEscape();
  await signOut(browser);

  // 31b. Weighbridge EDIT with qc_approvals VIEW: the QC hold is listed, read-only, with who decides it.
  await staffSignIn(browser, "pengawas.timbang");
  await browser.click('a[href="/keputusan"]');
  check(
    "an account that only reads QC holds lists one as Rincian, next to the plate request to decide",
    Boolean(await browser.waitFor(`location.pathname === '/keputusan' && ${visibleRows} === 2 && ${decisionButton("Tahan QC")}.includes('Rincian') && ${decisionButton("Plat tidak cocok")}.includes('Putuskan')`)),
  );
  await browser.click('button[aria-label^="Rincian Tahan QC"]');
  check(
    "the QC hold opens read-only and says who decides it",
    Boolean(await browser.waitFor(`(document.querySelector('[data-testid="approval-read-only"]')?.innerText ?? '') === 'Diputuskan oleh pemegang hak Keputusan QC tingkat ubah.'`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="approval-decide"]'))`)),
  );
  await browser.screenshot("31a-keputusan-qc-hanya-lihat-light");
  await browser.pressEscape();
  await browser.click('button[aria-label^="Rincian Plat tidak cocok"]');
  check("the plate request still opens with its decision controls", Boolean(await browser.waitFor(`Boolean(document.querySelector('[data-testid="approval-decide"]'))`)));
  await browser.pressEscape();
  await signOut(browser);

  // 31c. QC only: Keputusan in the menu and in the bell, and the QC hold decided.
  const qcToken = await apiSession("manajer.qc");
  const qcList = (await apiGet(qcToken, "/api/exceptions?limit=50")).items;
  const plate = weighbridgeList.find((item) => item.type === "PLATE" && item.status === "PENDING");
  const refused = await fetch(`${API}/api/exceptions/${plate?.id}/decide`, {
    method: "POST",
    headers: { authorization: `Bearer ${qcToken}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "APPROVE" }),
  });
  check(
    "the API lists only QC holds to a QC-only account and refuses it a plate request",
    qcList.length === 1 && qcList[0].type === "QC_HOLD" && refused.status === 403,
    `${qcList.map((item) => item.type).join(",")}, decide ${refused.status}`,
  );
  await staffSignIn(browser, "manajer.qc");
  check(
    "a QC-only account has Keputusan in its menu and the bell of the requests waiting",
    (await menuLinks(browser)).includes("/keputusan") &&
      Boolean(await browser.waitFor(`document.querySelector('[data-testid="notifications-bell"]')?.dataset.mode === 'approvals' && ${bellLabelText} === '1 permintaan menunggu keputusan'`)),
  );
  await browser.click('a[href="/keputusan"]');
  check(
    "from the menu, Keputusan lists the QC hold to decide",
    Boolean(await browser.waitFor(`location.pathname === '/keputusan' && ${visibleRows} === 1 && ${decisionButton("Tahan QC")}.includes('Putuskan')`)) &&
      Boolean(await browser.hasText("Hasil QC yang ditahan dan menunggu keputusan.")),
  );
  await browser.goto(`${WEB}/`);
  await browser.click('[data-testid="notifications-bell"]');
  check(
    "the bell entry of the QC hold leads to its decision",
    Boolean(
      await browser.waitFor(`(() => {
        const entry = ${panelEntry("Hasil QC menunggu keputusan")};
        return Boolean(entry) && entry.tagName === 'A' && entry.getAttribute('href') === '/keputusan?permintaan=${encodeURIComponent(qcHold?.id ?? "")}' &&
          document.querySelector('[data-testid="notifications-panel"] [data-testid="bell-decisions"]')?.getAttribute('href') === '/keputusan';
      })()`),
    ),
  );
  await browser.evaluate(`${panelEntry("Hasil QC menunggu keputusan")}.setAttribute('data-smoke', 'follow'); true`);
  await browser.click('[data-smoke="follow"]');
  check(
    "following it opens the QC hold with its decision controls",
    Boolean(await browser.waitFor(`location.pathname === '/keputusan' && Boolean(document.querySelector('[data-testid="approval-decide"]')) && (document.querySelector('[role="dialog"]')?.innerText ?? '').includes('truk lanjut ke bongkar')`)),
  );
  const decided = await stat("POST /api/exceptions/:id/decide");
  await browser.click("Setujui");
  check(
    "a QC-only account approves the QC hold",
    Boolean(await browser.waitFor(`(document.querySelector('[data-testid="approval-outcome"]')?.innerText ?? '').includes('Keputusan: Disetujui')`)) &&
      (await stat("POST /api/exceptions/:id/decide")) === decided + 1 &&
      (await apiGet(qcToken, `/api/exceptions/${qcHold?.id}`)).exception?.status === "APPROVED",
  );
  await browser.pressEscape();
  await browser.goto(`${WEB}/`);
  await signOut(browser);
}

async function phaseFive(browser) {
  // 35. Tangki: tanks from Odoo with the product name Odoo keeps, the note, the active switch, the sync.
  await staffSignIn(browser, "admin.contoh");
  const menu = await menuLinks(browser);
  check("Tangki and Segel are in the menu of a holder of plant_masters", menu.includes("/tangki") && menu.includes("/segel"), menu);
  await browser.click('a[href="/tangki"]');
  check("/tangki lists the tanks", (await browser.waitFor(`location.pathname === '/tangki' && ${visibleRows}`)) === 5);
  const pfad = await browser.evaluate(rowText("TK-201"));
  check("a tank from Odoo shows the product name Odoo keeps and its source", pfad.includes("PFAD") && pfad.includes("Odoo"), pfad);
  check("the page says the tanks are kept in Odoo", Boolean(await browser.hasText("Data tangki dikelola di Odoo.")));
  const unlabelled = await browser.evaluate(rowText("TK-LAMA"));
  check(
    "a tank without product and label is marked as not used by the forms, a labelled one is not",
    unlabelled.includes("Tanpa produk dan label") && unlabelled.includes("Tidak dipakai di form (tanpa label)") && !pfad.includes("Tidak dipakai di form"),
    unlabelled,
  );
  await browser.type('main input[type="search"]', "pfad");
  check("search narrows the tanks", (await browser.waitFor(`location.search.includes('q=pfad') && ${visibleRows} === 1 && ${visibleRows}`)) === 1);
  await browser.goto(`${WEB}/tangki`);
  await browser.waitFor(`${visibleRows} === 5`);
  await browser.click('button[aria-label="Tangki TK-101 aktif"]');
  check(
    "the switch turns a tank off",
    Boolean(await browser.hasText("Tangki TK-101 dinonaktifkan.")) && Boolean(await browser.waitFor(`${rowText("TK-101")}.includes('Nonaktif')`)),
  );
  await browser.click("Ambil dari Odoo");
  check("the Odoo sync reports its tank step", Boolean(await browser.hasText("Tangki dari Odoo: 0 tangki baru atau berubah.")));
  await browser.screenshot("40-tangki-light");

  // 36. Segel: status filter, a roll of seals, voiding an available seal.
  await browser.click('a[href="/segel"]');
  check("/segel lists the seal stock", (await browser.waitFor(`location.pathname === '/segel' && ${visibleRows}`)) === 12);
  await browser.goto(`${WEB}/segel?status=AVAILABLE`);
  check("the status filter keeps the available seals", (await browser.waitFor(`${visibleRows} === 9 && ${visibleRows}`)) === 9);
  await browser.click("Tambah segel");
  await browser.fill(inSheet('input[name="prefix"]'), "lc-");
  await browser.fill(inSheet('input[name="from"]'), "13");
  await browser.fill(inSheet('input[name="to"]'), "20");
  check("the form shows the first and the last number of the roll", Boolean(await browser.waitFor(`${textOf('[data-testid="seal-preview"]')}.includes('LC-000013 sampai LC-000020: 8 segel.')`)));
  await browser.click(inSheet('button[type="submit"]'));
  check("a roll of seals is added and counted", Boolean(await browser.hasText("8 segel ditambahkan (LC-000013 sampai LC-000020).")) && Boolean(await browser.waitFor(`${visibleRows} === 17`)));
  await browser.click('button[aria-label="Batalkan segel LC-000004"]');
  await browser.click(inSheet('button[type="submit"]'));
  check("an available seal is voided after a confirmation", Boolean(await browser.hasText("Segel LC-000004 dibatalkan.")) && Boolean(await browser.waitFor(`${visibleRows} === 16`)));
  await browser.screenshot("41-segel-light");
  await browser.colorScheme("dark");
  await browser.viewport(390, 844, true);
  for (const page of ["/tangki", "/segel"]) {
    await browser.goto(`${WEB}${page}`);
    await browser.waitFor("document.querySelector('main h1')");
    await sleep(400);
    check(`${page} has no horizontal scroll on a phone in the dark theme`, await browser.evaluate(noHorizontalScroll));
    await browser.screenshot(`42${page.replace("/", "-")}-phone-dark`);
  }
  await browser.viewport(1440, 900);
  await browser.colorScheme("light");

  // 37. Lampiran of a delivery order: logistics adds and removes, the transporter opens.
  const token = await apiSession("admin.contoh");
  const ordersOf = async (status) =>
    (await (await fetch(`${API}/api/delivery-orders?status=${status}&limit=50`, { headers: { authorization: `Bearer ${token}` } })).json()).items;
  const draft = (await ordersOf("DRAFT"))[0];
  const sent = (await ordersOf("SENT")).find((order) => order.transporter?.name === "Transporter Contoh A");
  await browser.goto(`${WEB}/delivery-order/${draft.id}`);
  check("a DO shows its Lampiran block", Boolean(await browser.waitFor(`${textOf('[data-testid="do-files"]')}.includes('Belum ada lampiran.')`)));
  const uploadsBefore = await stat("POST /api/files");
  await chooseFile(browser, '[data-testid="do-files"]', { name: "surat-do.pdf", type: "application/pdf", text: PDF_TEXT });
  check(
    "logistics attaches the DO letter",
    Boolean(await browser.waitFor(`${textOf('[data-testid="do-files"]')}.includes('surat-do.pdf')`)) &&
      (await stat("POST /api/files")) === uploadsBefore + 1 &&
      (await stat("POST /api/delivery-orders/:id/files")) === 1,
  );
  await browser.click('button[aria-label="Hapus surat-do.pdf"]');
  await browser.click("Ya, hapus");
  check("a file is removed after a confirmation", Boolean(await browser.waitFor(`${textOf('[data-testid="do-files"]')}.includes('Belum ada lampiran.')`)));
  await browser.goto(`${WEB}/delivery-order/${sent.id}`);
  await chooseFile(browser, '[data-testid="do-files"]', { name: "surat-do-kirim.pdf", type: "application/pdf", text: PDF_TEXT });
  await browser.waitFor(`${textOf('[data-testid="do-files"]')}.includes('surat-do-kirim.pdf')`);
  await browser.screenshot("43-do-lampiran-light");
  await signOut(browser);
  await partnerSignIn(browser, "transporter.contoh");
  await browser.goto(`${WEB}/delivery-order/${sent.id}`);
  check(
    "the transporter sees the letter and cannot change the files",
    Boolean(await browser.waitFor(`${textOf('[data-testid="do-files"]')}.includes('surat-do-kirim.pdf')`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="do-files"] input[type="file"]'))`)),
  );
  const reads = await stat("GET /api/files/:id");
  await browser.click('button[aria-label="Buka surat-do-kirim.pdf"]');
  check("Buka fetches the file for a new tab", Boolean(await browser.waitFor(`true`)) && (await waitStat("GET /api/files/:id", reads + 1)));
  await signOut(browser);

  // 37b. The printed SPJ of a truck of the DO made in step 23 shows the destination typed on that DO.
  {
    const reader = await apiSession("admin.contoh");
    const get = async (path) => (await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${reader}` } })).json();
    let printed = null;
    for (const trip of (await get("/api/trips?limit=50")).items ?? []) {
      if (trip.direction !== "OUT" || !trip.spj) continue;
      const spj = (await get(`/api/trips/${trip.id}/spj`)).spj;
      if (spj?.lines?.some((line) => line.destination?.name === "Gudang Uji Ketik")) {
        printed = trip.id;
        break;
      }
    }
    await staffSignIn(browser, "admin.contoh");
    await browser.goto(`${WEB}/spj/${printed}/cetak`);
    check(
      "the printed SPJ shows the typed destination",
      Boolean(printed) &&
        Boolean(await browser.waitFor(`${textOf('[data-testid="spj-sheet"]')}.includes('Gudang Uji Ketik, Jalan Uji No. 2, Kecamatan Uji, Kota Uji, Provinsi Uji')`)),
      String(printed),
    );
    await browser.goto(`${WEB}/`);
    await signOut(browser);
  }

  // 38. The post shows the slip of the scanned truck and opens it.
  if (slipRegistrationPath) {
    // the sign-outs above ended the earlier API session
    const reader = await apiSession("admin.contoh");
    const registration = (
      await (await fetch(`${API}/api/registrations/${slipRegistrationPath.split("/").at(-1)}`, { headers: { authorization: `Bearer ${reader}` } })).json()
    ).registration;
    await staffSignIn(browser, "pos.contoh");
    await browser.click('a[href="/pos"]');
    await browser.waitFor(`location.pathname === '/pos' && document.activeElement?.id === 'gate-scan'`);
    await browser.typeFocused(registration.trips[0].spj.barcodeToken);
    await browser.pressEnter();
    check("the scanned truck shows the slip of the PKS", Boolean(await browser.waitFor(`${textOf('[data-testid="gate-slips"]')}.includes('slip-pks.pdf')`)));
    const before = await stat("GET /api/files/:id");
    await browser.click('[data-testid="gate-slips"] button[aria-label="Buka slip-pks.pdf"]');
    check("the post opens the slip", await waitStat("GET /api/files/:id", before + 1));
    await browser.screenshot("44-pos-slip-light");
    await browser.goto(`${WEB}/`);
    await signOut(browser);
  }
}

// --- the archive of the old application, and vehicle verification ---------------------------------------------

async function historyAndVerification(browser) {
  const pagerText = textOf('[data-testid="pager"] [role="status"]');
  const params = (key) => `new URLSearchParams(location.search).get(${JSON.stringify(key)})`;

  // 39. Riwayat lama: the last 30 days by default, 50 rows a page, filters in the address bar.
  await staffSignIn(browser, "admin.contoh");
  await browser.colorScheme("dark");
  await browser.viewport(1440, 900);
  await browser.click('a[href="/riwayat"]');
  check(
    "/riwayat lists the archive of the last 30 days, 50 rows a page, with the totals in the header",
    Boolean(await browser.waitFor(`location.pathname === '/riwayat' && ${visibleRows} === 50 && /^1–50 dari 60 baris$/.test(${pagerText})`)) &&
      Boolean(await browser.hasText("Netto truk selesai")) &&
      Boolean(await browser.hasText("Hanya bisa dibaca")),
  );
  check("the history table fits 1440 px without scrolling", await browser.evaluate(`[...document.querySelectorAll('[data-slot="table-container"]')].every((box) => box.offsetParent === null || box.scrollWidth <= box.clientWidth) && ${noHorizontalScroll}`));
  check("a row of a multi-contract truck carries its mark", (await browser.evaluate(rowText("70001"))).includes("multi kontrak"));
  check(
    "an incoming reference that is not an Odoo contract carries a quiet mark with its reason, a known one does not",
    (await browser.evaluate(rowText("70008"))).includes("tanpa kontrak") &&
      !(await browser.evaluate(rowText("70001"))).includes("tanpa kontrak") &&
      (await browser.evaluate(`Boolean([...document.querySelectorAll('tbody tr')].find((row) => row.offsetParent !== null && row.innerText.includes('70008'))?.querySelector('[title="Nomor ini tidak ada di daftar kontrak Odoo. Ditampilkan seperti tercatat di aplikasi lama."]'))`)),
  );
  await browser.screenshot("45-riwayat-dark");
  await browser.click("Berikutnya");
  check("the next page shows the rest and keeps its number in the address", Boolean(await browser.waitFor(`/^51–60 dari 60 baris$/.test(${pagerText}) && ${params("page")} === '2'`)));
  await browser.goto(`${WEB}/riwayat${await browser.evaluate("location.search")}`);
  check("a reload keeps the page", Boolean(await browser.waitFor(`/^51–60 /.test(${pagerText})`)));
  await browser.fill('select[name="historyState"]', "REJECTED_QC");
  check(
    "the state filter goes into the address and back to page 1",
    Boolean(await browser.waitFor(`${params("state")} === 'REJECTED_QC' && !new URLSearchParams(location.search).has('page') && ${visibleRows} === 1 && ${rowText("70004")}.includes('Ditolak QC')`)),
  );
  await browser.fill('select[name="historyState"]', "");
  await browser.type('main input[type="search"]', "zz 9001", { perKey: true });
  check("the search finds a plate typed with a space and keeps it in the address", Boolean(await browser.waitFor(`${params("q")} === 'zz 9001' && ${visibleRows} === 1`)));
  await browser.fill('main input[type="search"]', "tidak-ada");
  check("a search without rows says so", Boolean(await browser.hasText("Tidak ada data yang cocok")));
  await browser.fill('main input[type="search"]', "");
  await browser.waitFor(`!new URLSearchParams(location.search).has('q') && ${visibleRows} === 50`);

  // the trucks whose reference is not in the Odoo contract list: a filter in the address, the dialog names the
  // number a reference and says why
  await browser.fill('select[name="historyContract"]', "missing");
  check(
    "the filter Tanpa kontrak di Odoo goes into the address and keeps only the marked rows",
    Boolean(
      await browser.waitFor(
        `${params("contract")} === 'missing' && ${visibleRows} === 3 && [...document.querySelectorAll('tbody tr')].filter((row) => row.offsetParent !== null).every((row) => row.innerText.includes('tanpa kontrak'))`,
      ),
    ) && (await browser.evaluate(`document.querySelector('select[name="historyContract"] option[value="missing"]')?.textContent === 'Tanpa kontrak di Odoo'`)),
  );
  await browser.goto(`${WEB}/riwayat${await browser.evaluate("location.search")}`);
  check("a reload keeps the contract filter", Boolean(await browser.waitFor(`${visibleRows} === 3 && document.querySelector('select[name="historyContract"]')?.value === 'missing'`)));
  await browser.click('tbody [data-history-open="8"]');
  check(
    "the dialog of such a truck calls the number Nomor acuan and says it is not in the Odoo contract list",
    Boolean(
      await browser.waitFor(
        `${textOf('[data-testid="history-detail"] dl')}.length > 0 && [...document.querySelectorAll('[data-testid="history-detail"] dt')].some((term) => term.innerText.trim() === 'Nomor acuan') && ![...document.querySelectorAll('[data-testid="history-detail"] dt')].some((term) => term.innerText.trim() === 'Kontrak') && ${textOf('[data-testid="history-no-contract"]')} === 'Nomor ini tidak ada di daftar kontrak Odoo. Bisa jadi nomor DO atau dokumen lain.'`,
      ),
    ),
  );
  await browser.pressEscape();
  await browser.waitFor(`!document.querySelector('[data-testid="history-dialog"]')`);
  await browser.fill('select[name="historyContract"]', "");
  await browser.waitFor(`!new URLSearchParams(location.search).has('contract') && ${visibleRows} === 50`);

  // the dialog of the multi-contract truck: its group, QC, the decision with its BA number, nothing to change
  await browser.colorScheme("light");
  await browser.click('tbody [data-history-open="1"]');
  const dialogText = textOf('[data-testid="history-dialog"]');
  check(
    "a row opens everything about the truck: group, QC, the decision with its BA number",
    Boolean(
      await browser.waitFor(
        `${dialogText}.includes('Satu truk, beberapa kontrak') && ${dialogText}.includes('0109/KONTRAK/REK/XI/2026') && ${dialogText}.includes('BA-REK/2026/0051') && ${dialogText}.includes('FFA') && ${dialogText}.includes('Kolom lain dari aplikasi lama')`,
      ),
    ),
  );
  check(
    "a member of the group without an Odoo contract is labelled Nomor acuan, with the reason said once under the table",
    await browser.evaluate(
      `(() => { const rows = [...document.querySelectorAll('[data-testid="history-group"] tbody tr')].map((row) => row.innerText.replace(/\\s+/g, ' ')); const note = [...document.querySelectorAll('[data-testid="history-group"] ~ p')].map((line) => line.innerText); return rows.some((row) => row.includes('Nomor acuan') && row.includes('0109/KONTRAK/REK/XI/2026')) && !rows.some((row) => row.includes('Nomor acuan') && row.includes('0101/KONTRAK/REK/XI/2026')) && note.filter((line) => line.includes('Nomor ini tidak ada di daftar kontrak Odoo.')).length === 1 && !${dialogText}.includes('Nomor ini tidak ada di daftar kontrak Odoo. Ditampilkan'); })()`,
    ),
  );
  check(
    "the dialog has nothing to edit",
    await browser.evaluate(`!document.querySelector('[data-testid="history-dialog"] input, [data-testid="history-dialog"] textarea, [data-testid="history-dialog"] select') && [...document.querySelectorAll('[data-testid="history-dialog"] button')].every((button) => ['Tutup', 'Coba lagi'].includes(button.innerText.trim()) || button.querySelector('.sr-only'))`),
  );
  await browser.screenshot("46-riwayat-rincian-light");
  await browser.pressEscape();
  check("Escape closes the dialog and gives the focus back to the row", Boolean(await browser.waitFor(`!document.querySelector('[data-testid="history-dialog"]') && document.activeElement?.getAttribute('data-history-open') === '1'`)));
  await browser.click('tbody [data-history-open="7"]');
  check(
    "a value the import could not read shows its original text, marked",
    Boolean(await browser.waitFor(`${dialogText}.includes('40.010 kg') && ${dialogText}.includes('teks asli') && ${dialogText}.includes('kemarin pagi')`)),
  );
  await browser.pressEscape();
  await browser.waitFor(`!document.querySelector('[data-testid="history-dialog"]')`);
  await browser.screenshot("47-riwayat-light");

  const csvBefore = await stat("GET /api/history/trips");
  await browser.click("Unduh CSV");
  check("Unduh CSV fetches the filtered set without an error", (await waitStat("GET /api/history/trips", csvBefore + 1)) && !(await browser.evaluate("document.body.innerText.includes('CSV belum bisa diunduh')")));

  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/riwayat`);
  await browser.waitFor("[...document.querySelectorAll('main ul > li')].filter((li) => li.offsetParent !== null).length > 0");
  check("/riwayat has no horizontal scroll on a phone", await browser.evaluate(noHorizontalScroll));
  await browser.screenshot("48-riwayat-phone-light");
  await browser.click('main ul > li [data-history-open="3"]');
  await browser.waitFor(`${dialogText}.includes('Ditolak kebersihan')`);
  check("the dialog fits a phone", await browser.evaluate(noHorizontalScroll));
  await browser.screenshot("49-riwayat-rincian-phone-light");
  await browser.pressEscape();
  await browser.viewport(1440, 900);

  // 40. Kendaraan: the badge, the filter, verify and cancel it with a confirmation naming the plate.
  await browser.goto(`${WEB}/kendaraan`);
  await browser.waitFor(`${rowText("ZZ 0005 CTH")} !== ''`);
  const unverifiedRow = await browser.evaluate(rowText("ZZ 0005 CTH"));
  check("an unverified vehicle carries the badge and the reason", unverifiedRow.includes("Belum diverifikasi") && unverifiedRow.includes("tarra belum jadi acuan"), unverifiedRow);
  check("a verified vehicle has no badge", !(await browser.evaluate(rowText("ZZ 0001 CTH"))).includes("Belum diverifikasi"));
  await browser.screenshot("50-kendaraan-verifikasi-light");
  await browser.click('[aria-label="Saring menurut verifikasi"] button[aria-pressed="false"]');
  check(
    "the filter keeps the unverified vehicles, says why it matters, and goes into the address",
    Boolean(
      await browser.waitFor(
        `${params("verifikasi")} === 'belum' && ${visibleRows} > 0 && [...document.querySelectorAll('tbody tr')].every((row) => row.innerText.includes('Belum diverifikasi')) && Boolean(document.querySelector('[data-testid="unverified-note"]'))`,
      ),
    ),
  );
  await browser.click('button[aria-label="Verifikasi ZZ 0005 CTH"]');
  check("the confirmation names the plate", Boolean(await browser.waitFor(`${textOf('[role="dialog"]')}.includes('Verifikasi ZZ 0005 CTH') && ${textOf('[role="dialog"]')}.includes('belum punya tarra master')`)));
  const verifies = await stat("POST /api/vehicles/:id/verify");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "verifying removes the vehicle from the filtered list",
    Boolean(await browser.hasText("Kendaraan ZZ 0005 CTH diverifikasi.")) && (await stat("POST /api/vehicles/:id/verify")) === verifies + 1 && Boolean(await browser.waitFor(`${rowText("ZZ 0005 CTH")} === ''`)),
  );
  await browser.click('[aria-label="Saring menurut verifikasi"] button[aria-pressed="false"]');
  await browser.waitFor(`!new URLSearchParams(location.search).has('verifikasi') && ${rowText("ZZ 0005 CTH")} !== ''`);
  await browser.click('button[aria-label="Tindakan lain ZZ 0005 CTH"]');
  await browser.click("Batalkan verifikasi");
  await browser.waitFor(`${textOf('[role="dialog"]')}.includes('Batalkan verifikasi ZZ 0005 CTH')`);
  await browser.click(inSheet('button[type="submit"]'));
  check("cancelling the verification brings the badge back", Boolean(await browser.hasText("Verifikasi kendaraan ZZ 0005 CTH dibatalkan.")) && Boolean(await browser.waitFor(`${rowText("ZZ 0005 CTH")}.includes('Belum diverifikasi')`)));

  // someone else verifies it meanwhile: the refusal is said in plain words and the list is reloaded
  await browser.click('button[aria-label="Verifikasi ZZ 0005 CTH"]');
  await browser.waitFor(`${textOf('[role="dialog"]')}.includes('Verifikasi ZZ 0005 CTH')`);
  const other = await apiSession("super.contoh");
  const vehicleId = (await (await fetch(`${API}/api/vehicles?q=zz0005cth`, { headers: { authorization: `Bearer ${other}` } })).json()).items[0].id;
  await fetch(`${API}/api/vehicles/${vehicleId}/verify`, { method: "POST", headers: { authorization: `Bearer ${other}` } });
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "a vehicle verified meanwhile gives a plain refusal and the list catches up",
    Boolean(await browser.hasText("ZZ 0005 CTH sudah diverifikasi sebelumnya, mungkin oleh orang lain.")) &&
      Boolean(await browser.waitFor(`!${rowText("ZZ 0005 CTH")}.includes('Belum diverifikasi')`)),
  );
  await browser.click("Batal");
  await fetch(`${API}/api/vehicles/${vehicleId}/unverify`, { method: "POST", headers: { authorization: `Bearer ${other}` } });
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  // 41. A partner account: the badge on its own vehicles without any action, and no archive.
  await partnerSignIn(browser, "transporter.contoh");
  check("a partner account has no Riwayat lama in its menu", !(await menuLinks(browser)).includes("/riwayat"));
  await browser.click('a[href="/kendaraan"]');
  await browser.waitFor(`${rowText("ZZ 0005 CTH")} !== ''`);
  check(
    "the partner sees the badge on its own vehicle but no verification action",
    (await browser.evaluate(rowText("ZZ 0005 CTH"))).includes("Belum diverifikasi") &&
      !(await browser.evaluate(`Boolean(document.querySelector('button[aria-label^="Verifikasi"], button[aria-label^="Tindakan lain"]'))`)),
  );
  const historyReads = await stat("GET /api/history/trips");
  await browser.goto(`${WEB}/riwayat`);
  check("/riwayat refuses a partner account without asking the API", Boolean(await browser.hasText("Anda tidak punya akses ke halaman ini")) && (await stat("GET /api/history/trips")) === historyReads);
  await browser.goto(`${WEB}/`);
  await signOut(browser);
}

/** How many OpenStreetMap tiles the browser asked for, all answered by the mock (set once the page is open). */
let tilesServed = () => 0;

async function gpsTracking(browser) {
  // 42. Lacak kendaraan for staff with gps EDIT: three tracked trucks, their states, filters kept in the address bar.
  await browser.viewport(1440, 900);
  await staffSignIn(browser, "super.contoh");
  const menu = await menuLinks(browser);
  check("Lacak kendaraan sits after the post and before Keputusan in the menu", menu.includes("/pos /lacak /keputusan"), menu);
  await browser.click('a[href="/lacak"]');
  const rows = `[...document.querySelectorAll('[data-testid="gps-row"]')]`;
  const rowOf = (plate) => `(${rows}.find((row) => row.innerText.includes(${JSON.stringify(plate)}))?.innerText ?? '').replace(/\\s+/g, ' ')`;
  check("/lacak lists the three tracked trucks", (await browser.waitFor(`location.pathname === '/lacak' && ${rows}.length`)) === 3);
  check(
    "each row says the state in words: moving, stopped, no news",
    (await browser.evaluate(rowOf("ZZ 0003 CTH"))).includes("Bergerak") &&
      (await browser.evaluate(rowOf("ZZ 0002 CTH"))).includes("Berhenti") &&
      (await browser.evaluate(rowOf("ZZ 0001 CTH"))).includes("Tidak ada kabar"),
    await browser.evaluate(rows + ".map((row) => row.innerText.replace(/\\s+/g, ' ')).join(' | ')"),
  );
  check(
    "every truck has a marker with its plate, its state sign and the state for screen readers",
    Boolean(
      await browser.waitFor(`(() => {
        const markers = [...document.querySelectorAll('.gps-marker[data-state]')];
        const states = markers.map((marker) => marker.dataset.vehicleId + ':' + marker.dataset.state).sort().join(' ');
        return markers.length === 3 && states === 'v-1:SILENT v-2:STOPPED v-3:MOVING' &&
          markers.every((marker) => marker.querySelector('.gps-marker-state svg') && marker.querySelector('.sr-only') && marker.getAttribute('role') === 'button');
      })()`),
    ),
  );
  check("the map tiles came from the mock, not the internet", tilesServed() > 0, `${tilesServed()} tiles`);
  check("the map shows the OpenStreetMap attribution", Boolean(await browser.waitFor(`document.querySelector('.leaflet-control-attribution')?.innerText.includes('OpenStreetMap')`)));

  const chip = (n) => `[aria-label="Saring menurut keadaan truk"] button:nth-child(${n})`;
  await browser.click(chip(2));
  check("Bergerak keeps the moving truck and goes into the address bar", Boolean(await browser.waitFor(`${rows}.length === 1 && location.search.includes('keadaan=bergerak')`)) && (await browser.evaluate(rowOf("ZZ 0003 CTH"))) !== "");
  await browser.click(chip(4));
  check("Tidak ada kabar keeps the silent truck", Boolean(await browser.waitFor(`${rows}.length === 1 && ${rowOf("ZZ 0001 CTH")} !== ''`)) && (await browser.evaluate("document.querySelectorAll('.gps-marker').length")) === 1);
  await browser.click(chip(1));
  await browser.waitFor(`${rows}.length === 3 && !location.search.includes('keadaan')`);
  await browser.type('input[type="search"]', "0002", { perKey: true });
  check("a plate search narrows the list and is kept in the address bar", Boolean(await browser.waitFor(`${rows}.length === 1 && location.search.includes('q=0002')`)));
  await browser.click('button[aria-label="Hapus pencarian"]');
  await browser.waitFor(`${rows}.length === 3`);

  // a marker click, while every truck is in view
  const panel = textOf('[data-testid="gps-panel"]');
  await browser.click('.gps-marker[data-vehicle-id="v-2"] .gps-marker-truck');
  check("a marker click selects its truck", Boolean(await browser.waitFor(`${panel}.includes('ZZ 0002 CTH') && ${panel}.includes('Ponsel supir') && location.search.includes('vehicle=v-2')`)));

  // selecting from the list: the panel, the track, the address bar
  await browser.click('[data-testid="gps-row"][data-vehicle-id="v-3"]');
  check(
    "selecting a truck shows its trip, partner, last point and source in words",
    Boolean(await browser.waitFor(`${panel}.includes('ZZ 0003 CTH') && ${panel}.includes('Incoming') && ${panel}.includes('PKS Contoh B') && ${panel}.includes('Alat pelacak') && ${panel}.includes('km/jam')`)),
    await browser.evaluate(panel),
  );
  check("the selection is kept in the address bar", (await location(browser)).includes("vehicle=v-3"));
  check(
    "its current trip's track is drawn",
    Boolean(await browser.waitFor(`document.querySelector('path.gps-track') && ${textOf('[data-testid="gps-track-text"]')}.includes('Jejak perjalanan') && ${textOf('[data-testid="gps-track-text"]')}.includes('titik')`)),
    await browser.evaluate(textOf('[data-testid="gps-track-text"]')),
  );
  check("the selected marker and row are marked", Boolean(await browser.waitFor(`document.querySelector('.gps-marker[data-vehicle-id="v-3"]')?.dataset.selected === 'true' && document.querySelector('[data-testid="gps-row"][data-vehicle-id="v-3"]')?.getAttribute('aria-pressed') === 'true'`)));
  await browser.screenshot("42-lacak-selected");
  await browser.evaluate(`document.querySelector('.gps-marker[data-vehicle-id="v-1"]').focus()`);
  await browser.pressEnter();
  check("Enter on a focused marker selects it", Boolean(await browser.waitFor(`${panel}.includes('ZZ 0001 CTH') && ${panel}.includes('Tidak ada kabar') && ${panel}.includes('Jejak 24 jam terakhir')`)));
  await browser.click('button[aria-label="Tutup rincian truk"]');
  check("closing the panel clears the selection", Boolean(await browser.waitFor(`!document.querySelector('[data-testid="gps-panel"]') && !location.search.includes('vehicle=')`)));
  await browser.goto(`${WEB}/lacak?vehicle=v-3`);
  check("?vehicle= opens with that truck selected", Boolean(await browser.waitFor(`${panel}.includes('ZZ 0003 CTH')`)));
  await browser.goto(`${WEB}/lacak?trip=trip-2`);
  check(
    "a trip whose truck has no position says so plainly",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gps-no-position"]')}.includes('belum punya posisi')`)),
  );
  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/lacak`);
  await browser.waitFor(`${rows}.length === 3`);
  check(
    "at phone width the list sits under the map, without horizontal scroll",
    await browser.evaluate(`(() => {
      const map = document.querySelector('.gps-map').getBoundingClientRect();
      const row = document.querySelector('[data-testid="gps-row"]').getBoundingClientRect();
      return row.top >= map.bottom && document.documentElement.scrollWidth <= window.innerWidth;
    })()`),
  );
  await browser.viewport(1440, 900);

  // 43. Pengaturan GPS: a new source shows its key once; an unknown device goes onto a vehicle; the settings save.
  await browser.goto(`${WEB}/lacak`);
  await browser.click('a[href="/lacak/pengaturan"]');
  await browser.waitFor(`document.querySelector('[data-testid="gps-source"]')`);
  await browser.click("Sumber baru");
  await browser.fill(inSheet('input[name="sourceName"]'), "Penyedia Uji Asap");
  await browser.fill(inSheet('select[name="sourceKind"]'), "DEVICE");
  await browser.click(inSheet('button[type="submit"]'));
  const key = await browser.waitFor(`document.querySelector('#gps-key-value')?.textContent`);
  check("a new source shows its key once in a dialog with a copy button and a warning", /^gs\d+\.[A-Za-z0-9_-]{43}$/.test(key ?? "") && (await browser.evaluate(textOf('[data-testid="gps-key-dialog"]'))).includes("hanya tampil sekali") && (await browser.evaluate(`[...document.querySelectorAll('[data-testid="gps-key-dialog"] button')].some((b) => b.innerText.includes('Salin'))`)), key ?? "");
  await browser.screenshot("43-gps-key");
  await browser.click("Sudah saya simpan");
  check(
    "after the dialog the key is nowhere on the page, and the source is listed",
    Boolean(await browser.waitFor(`!document.querySelector('[data-testid="gps-key-dialog"]') && document.querySelector('[data-source-name="Penyedia Uji Asap"]')`)) &&
      !(await browser.evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(key ?? "-")})`)),
    await browser.evaluate(
      `JSON.stringify({ dialog: Boolean(document.querySelector('[data-testid="gps-key-dialog"]')), names: [...document.querySelectorAll('[data-source-name]')].map((n) => n.dataset.sourceName), keyIn: document.documentElement.outerHTML.includes(${JSON.stringify(key ?? "-")}) })`,
    ),
  );
  await browser.click('[data-source-name="Penyedia Contoh"] button[aria-expanded]');
  await browser.click('button[aria-label="Pasang ALAT-0099 ke kendaraan"]');
  await pickOption(browser, inSheet('input[name="trackerVehicle"]'), "ZZ 0002");
  check("attaching an unknown device starts with its source and number", (await browser.evaluate(`document.querySelector('[role="dialog"] input[name="trackerDevice"]').value`)) === "ALAT-0099");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "the device is attached and listed under its vehicle",
    Boolean(await browser.hasText("Alat ALAT-0099 terpasang di ZZ 0002 CTH.")) &&
      Boolean(await browser.waitFor(`document.querySelector('[data-testid="gps-tracker"][data-plate="ZZ 0002 CTH"]') && !document.querySelector('button[aria-label="Pasang ALAT-0099 ke kendaraan"]')`)),
    await browser.evaluate(`document.querySelector('main').innerText.replace(/\\s+/g, ' ').slice(0, 500)`),
  );
  await browser.fill('input[name="retentionDays"]', "6");
  await browser.click("Simpan pengaturan");
  check("a retention out of range is refused next to the field", Boolean(await browser.hasText("Isi angka bulat dari 7 sampai 730.")));
  await browser.fill('input[name="retentionDays"]', "30");
  await browser.click("Pakai titik tengah peta");
  check("Pakai titik tengah peta fills both coordinates", Boolean(await browser.waitFor(`/^-?\\d/.test(document.querySelector('input[name="plantLat"]').value) && /^-?\\d/.test(document.querySelector('input[name="plantLon"]').value)`)));
  await browser.click("Simpan pengaturan");
  const staffToken = await apiSession("super.contoh");
  const saved = await browser.hasText("Pengaturan GPS disimpan.");
  const stored = (await (await fetch(`${API}/api/gps/settings`, { headers: { authorization: `Bearer ${staffToken}` } })).json()).settings;
  check("the settings are saved", Boolean(saved) && stored.retentionDays === 30 && stored.plantLocation !== null, JSON.stringify(stored));
  check("the page explains how a provider sends positions", (await browser.evaluate(textOf('[data-testid="gps-howto"]'))).includes("X-Tracker-Key") && (await browser.evaluate(textOf('[data-testid="gps-howto"]'))).includes("/api/gps/positions"));

  // 44. Kendaraan: the GPS mark, and the tracker dialog of a vehicle.
  await browser.goto(`${WEB}/kendaraan`);
  await browser.waitFor(`${rowText("ZZ 0003 CTH")} !== ''`);
  check(
    "vehicles with a tracker carry the GPS mark, others do not",
    (await browser.evaluate(`[...document.querySelectorAll('tbody tr')].filter((row) => row.offsetParent !== null && row.querySelector('[data-testid="vehicle-gps"]')).map((row) => row.innerText.match(/ZZ \\d{4} CTH/)?.[0]).sort().join()`)) === "ZZ 0001 CTH,ZZ 0002 CTH,ZZ 0003 CTH",
  );
  await browser.click('button[aria-label="Alat GPS ZZ 0003 CTH"]');
  check("the vehicle's tracker dialog shows the device it has", Boolean(await browser.waitFor(`${textOf('[data-testid="tracker-attached"]')}.includes('ALAT-0003')`)));
  await browser.click("Batal");

  // 45. A trip row links to its position; the SPJ carries the second QR code.
  await browser.goto(`${WEB}/registrasi/r-1`);
  await browser.click('a[href="/lacak?trip=trip-1"]');
  check("Lihat posisi on a trip row opens the map on that truck", Boolean(await browser.waitFor(`location.search.includes('trip=trip-1') && ${panel}.includes('ZZ 0003 CTH')`)));
  await browser.goto(`${WEB}/spj/trip-1/cetak`);
  await browser.waitFor(`document.querySelector('[data-testid="spj-sheet"]')`);
  check(
    "the SPJ of a trip on the road has a second, smaller QR for sharing the location",
    Boolean(await browser.waitFor(`document.querySelectorAll('[data-testid="spj-sheet"] [data-barcode="qr"]').length === 2`)) &&
      (await browser.evaluate(textOf('[data-testid="spj-share"]'))).includes("Bagikan lokasi (opsional)"),
  );
  await browser.media("print");
  check("the SPJ with two QR codes still fits one A5 page", await browser.evaluate(`document.querySelector('[data-testid="spj-sheet"]').getBoundingClientRect().height <= 190 * 96 / 25.4`), String(await browser.evaluate(`document.querySelector('[data-testid="spj-sheet"]').getBoundingClientRect().height`)));
  await browser.screenshot("45-spj-two-qr");
  await browser.media("");
  await browser.goto(`${WEB}/spj/trip-2/cetak`);
  await browser.waitFor(`document.querySelector('[data-testid="spj-sheet"]')`);
  check("an SPJ without a share link prints with one QR", (await browser.evaluate(`document.querySelectorAll('[data-testid="spj-sheet"] [data-barcode="qr"]').length`)) === 1 && !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="spj-share"]'))`)));
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  // 46. A partner account sees only its own trucks and no settings.
  await partnerSignIn(browser, "transporter.contoh");
  check("a partner account with gps VIEW has Lacak kendaraan in its menu", (await menuLinks(browser)).includes("/lacak"));
  await browser.click('a[href="/lacak"]');
  await browser.waitFor(`${rows}.length > 0`);
  check(
    "the transporter sees its own two trucks and not the other company's",
    (await browser.evaluate(`${rows}.map((row) => row.innerText.match(/ZZ \\d{4} CTH/)?.[0]).sort().join()`)) === "ZZ 0001 CTH,ZZ 0002 CTH",
  );
  check("a partner gets no settings tab", !(await browser.evaluate(`Boolean(document.querySelector('a[href="/lacak/pengaturan"]'))`)));
  await browser.goto(`${WEB}/lacak/pengaturan`);
  check("/lacak/pengaturan refuses a partner account", Boolean(await browser.hasText("Anda tidak punya akses ke halaman ini")));
  await browser.goto(`${WEB}/`);
  await signOut(browser);
}

/** Pastes `text` into an input the way a browser does: a paste event the page may take over. */
const pasteInto = (selector, text) => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  input.focus();
  const data = new DataTransfer();
  data.setData('text/plain', ${JSON.stringify(text)});
  return input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
})()`;

async function destinationPins(browser) {
  // 48. The destination pin of a DO: typed or pasted in the DO form, shown on the DO page with a Google Maps link,
  // on Lacak kendaraan for the truck that carries the DO, and on the driver's page.
  await browser.viewport(1440, 900);
  await staffSignIn(browser, "super.contoh");
  await browser.goto(`${WEB}/delivery-order`);
  await browser.waitFor(`${visibleRows} > 0`);
  await browser.click("DO baru");
  await pickOption(browser, inSheet('input[name="contractLookup"]'), "0047/CONTOH");
  await browser.fill(inSheet('input[name="destName"]'), "Gudang Pin Uji");
  await browser.fill(inSheet('input[name="destRegency"]'), "Kab. Pin Uji");
  await browser.fill(inSheet('input[name="qty"]'), "12000");
  check("the DO form has an optional part for the destination pin with a map", (await browser.evaluate(textOf('[data-testid="do-pin"]'))).includes("Pin lokasi tujuan (opsional)") && Boolean(await browser.waitFor(`document.querySelector('[data-testid="do-pin"] .gps-map')`)));
  const lat = inSheet('input[name="destLat"]');
  const lon = inSheet('input[name="destLon"]');
  const pinValues = `document.querySelector(${JSON.stringify(lat)}).value + ' | ' + document.querySelector(${JSON.stringify(lon)}).value`;
  const pasteTaken = await browser.evaluate(pasteInto(lat, "-10.7, 85.6"));
  check("pasting a Google Maps pair into the latitude field fills both fields", pasteTaken === false && (await browser.waitFor(`${pinValues} === '-10.7 | 85.6' ? ${pinValues} : ''`)) === "-10.7 | 85.6", await browser.evaluate(pinValues));
  check("the pin is drawn on the map once both fields hold a point", Boolean(await browser.waitFor(`document.querySelector('[data-testid="do-pin"] .gps-destination')`)));
  await browser.click("Hapus pin");
  check("Hapus pin empties both fields and takes the pin off the map", Boolean(await browser.waitFor(`${pinValues} === ' | ' && !document.querySelector('[data-testid="do-pin"] .gps-destination')`)));
  await browser.fill(lat, "-10.7");
  await browser.click(inSheet('button[type="submit"]'));
  check("a pin with only a latitude is refused next to the longitude", Boolean(await browser.hasText("Isi bujur juga, atau kosongkan keduanya.")));
  await browser.click("Pakai titik tengah peta");
  check("Pakai titik tengah peta fills both fields of the pin", Boolean(await browser.waitFor(`/^-?\\d/.test(document.querySelector(${JSON.stringify(lat)}).value) && /^-?\\d/.test(document.querySelector(${JSON.stringify(lon)}).value)`)));
  await browser.evaluate(pasteInto(lon, "(-10.7, 85.6)"));
  await browser.waitFor(`${pinValues} === '-10.7 | 85.6'`);
  await browser.click(inSheet('button[type="submit"]'));
  const created = (await browser.waitFor(`[...document.querySelectorAll('p')].find((p) => p.innerText.includes('dibuat sebagai draf'))?.innerText`)) ?? "";
  const doNo = /DO (\S+) dibuat/.exec(created)?.[1] ?? "";
  const token = await apiSession("super.contoh");
  const found = (await (await fetch(`${API}/api/delivery-orders?q=${encodeURIComponent(doNo)}`, { headers: { authorization: `Bearer ${token}` } })).json()).items?.[0];
  check("the DO is saved with its pin", JSON.stringify(found?.destination?.location) === JSON.stringify({ lat: -10.7, lon: 85.6 }), JSON.stringify(found?.destination));

  await browser.goto(`${WEB}/delivery-order/${encodeURIComponent(String(found?.id))}`);
  const view = '[data-testid="do-pin-view"]';
  check("the DO page shows the pin on a small map with its coordinates", Boolean(await browser.waitFor(`document.querySelector('${view} .gps-destination') && ${textOf('[data-testid="do-pin-coordinates"]')} === '-10.7, 85.6'`)));
  check(
    "Buka di Google Maps opens the place in a new tab without passing the page on",
    (await browser.evaluate(`(() => { const a = [...document.querySelectorAll('${view} a')].find((link) => link.innerText.includes('Buka di Google Maps')); return a ? [a.href, a.target, a.rel].join(' ') : ''; })()`)) ===
      "https://www.google.com/maps?q=-10.7,85.6 _blank noopener noreferrer",
  );
  check("nothing on the DO page was fetched from Google", !(await browser.evaluate(`performance.getEntriesByType('resource').some((entry) => entry.name.includes('google'))`)));

  // the truck on the outgoing trip of the pinned DO
  await browser.goto(`${WEB}/lacak?vehicle=v-2`);
  const panel = textOf('[data-testid="gps-panel"]');
  check(
    "the selected truck's panel names its destination and the distance to it",
    Boolean(await browser.waitFor(`${panel}.includes('Tujuan') && ${panel}.includes('Jarak ke tujuan') && ${panel}.includes('km')`)),
    await browser.evaluate(panel),
  );
  check(
    "the destination has its own marker on the map, inside the view with the truck",
    Boolean(
      await browser.waitFor(`(() => {
        const map = document.querySelector('.gps-map').getBoundingClientRect();
        const pin = document.querySelector('.gps-map .gps-destination')?.getBoundingClientRect();
        const truck = document.querySelector('.gps-marker[data-vehicle-id="v-2"]')?.getBoundingClientRect();
        const inside = (box) => box && box.left >= map.left && box.right <= map.right && box.top >= map.top && box.bottom <= map.bottom;
        return inside(pin) && inside(truck) && !document.querySelector('.gps-map .gps-destination .gps-marker-truck');
      })()`),
    ),
  );
  const trip = await (await fetch(`${API}/api/gps/vehicles`, { headers: { authorization: `Bearer ${token}` } })).json();
  const tripId = trip.items.find((item) => item.vehicle.id === "v-2")?.trip?.id;
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  // the driver of that truck can open the place in a maps app
  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/bagi-lokasi/contoh-${tripId}`);
  check(
    "the driver's page names the destination with a Buka di peta link",
    Boolean(await browser.waitFor(`${textOf('[data-testid="share-destination"]')}.includes('Tujuan:') && document.querySelector('[data-testid="share-destination"] a')?.href.startsWith('https://www.google.com/maps?q=')`)),
    await browser.evaluate(shareDetail),
  );
  check("the driver's page with a destination has no horizontal scroll at 390 px", await browser.evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
  await browser.viewport(1440, 900);
}

/** Where the driver's page is and which of its screens shows, for a failed check. */
const shareDetail = `location.pathname + ' ' + [...document.querySelectorAll('[data-testid^="share-"]')].map((node) => node.dataset.testid).join(',') + ' ' + typeof navigator.geolocation`;

async function driverSharing(browser) {
  // 47. The driver's page, without an account: link unknown, closed, sharing with an emulated location, refused,
  // a browser without location, and a page outside HTTPS (the last two made by scripts only this test installs).
  await browser.bringToFront();
  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/bagi-lokasi/tidak-ada`);
  check("an unknown link says so", Boolean(await browser.waitFor(`document.querySelector('[data-testid="share-unknown"]')`)), await browser.evaluate(shareDetail));
  await browser.goto(`${WEB}/bagi-lokasi/contoh-tutup`);
  check("a closed link says sharing is closed and shows the plate", Boolean(await browser.waitFor(`document.querySelector('[data-testid="share-closed"]') && ${textOf('[data-testid="share-plate"]')} === 'ZZ 0004 CTH'`)));

  await browser.permission(WEB, "geolocation", "granted");
  await browser.geolocation({ lat: -10.52, lon: 85.2, accuracy: 12 });
  await browser.goto(`${WEB}/bagi-lokasi/contoh-buka`);
  check(
    "an open link names the truck and says what is shared, with whom and until when",
    Boolean(await browser.waitFor(`document.querySelector('[data-testid="share-ready"]') && ${textOf('[data-testid="share-plate"]')} === 'ZZ 0003 CTH'`)) &&
      (await browser.evaluate(textOf('[data-testid="share-explainer"]'))).includes("Sampai truk selesai"),
  );
  check("the driver's page has no horizontal scroll at 390 px", await browser.evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
  await browser.geolocation({ lat: -10.52, lon: 85.2, accuracy: 12 });
  const fix = await browser.evaluate(
    `Promise.race([
      new Promise((resolve) => navigator.geolocation.getCurrentPosition((p) => resolve('fix ' + p.coords.accuracy), (e) => resolve('error ' + e.code), { timeout: 4000 })),
      new Promise((resolve) => setTimeout(() => resolve('no answer (permission still asked?)'), 6000)),
    ])`,
  );
  check("the browser gives the emulated location", fix === "fix 12", fix);
  await browser.click("Bagikan lokasi");
  check(
    "sharing sends the first point at once and shows when and how exact",
    Boolean(await browser.waitFor(`document.querySelector('[data-testid="share-active"]') && !${textOf('[data-testid="share-last-sent"]')}.includes('belum')`)) &&
      (await browser.evaluate(textOf('[data-testid="share-active"]'))).includes("± 12 m"),
    await browser.evaluate(textOf('[data-testid="share-active"]')),
  );
  const sent = await (await fetch(`${API}/__mock/gps-share-points`)).json();
  check("the points reached the share route", (sent["contoh-buka"] ?? 0) >= 1, JSON.stringify(sent));
  await browser.screenshot("47-share-active");
  await browser.click("Berhenti");
  check("Berhenti stops sharing", Boolean(await browser.waitFor(`document.querySelector('[data-testid="share-ready"]')`)));
  await fetch(`${API}/__mock/gps-share/contoh-buka/close`, { method: "POST" });
  await browser.click("Bagikan lokasi");
  check("a link closed while sharing turns into the closed screen", Boolean(await browser.waitFor(`document.querySelector('[data-testid="share-closed"]')`)));

  await browser.permission(WEB, "geolocation", "denied");
  await browser.goto(`${WEB}/bagi-lokasi/contoh-buka-2`);
  check("a refused location permission explains how to allow it", Boolean(await browser.waitFor(`${textOf('[data-testid="share-denied"]')}.includes('Izinkan')`)));
  await browser.permission(WEB, "geolocation", "granted");

  const noLocation = await browser.addInitScript("Object.defineProperty(Navigator.prototype, 'geolocation', { configurable: true, get: () => undefined });");
  await browser.goto(`${WEB}/bagi-lokasi/contoh-buka-2`);
  check("a browser without location says so", Boolean(await browser.waitFor(`document.querySelector('[data-testid="share-unsupported"]')`)), await browser.evaluate(shareDetail));
  await browser.removeInitScript(noLocation);
  const plainHttp = await browser.addInitScript("Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => false });");
  await browser.goto(`${WEB}/bagi-lokasi/contoh-buka-2`);
  check("a page outside HTTPS says the browser gives the location only on HTTPS", Boolean(await browser.waitFor(`${textOf('[data-testid="share-insecure"]')}.includes('https://')`)));
  await browser.removeInitScript(plainHttp);
  await browser.geolocation(null);
  await browser.permission(WEB, "geolocation", "prompt");
  await browser.viewport(1366, 900);
}

/** Waits until the mock has answered `route` at least `count` times. */
// --- the registration post without a barcode: marks at check-in, scanned documents, the emergency path ----------

/**
 * Plays the scanner helper of the post PC (tools/scanner-helper of the old application): GET /status and
 * GET /scan, with the same CORS headers. Records every request so the checks see what the browser sent.
 */
function startFakeScanner(jpeg) {
  const requests = [];
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "X-Scan-Seconds",
    "cache-control": "no-store",
  };
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", SCANNER);
    const json = (status, body) => {
      response.writeHead(status, { ...cors, "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    const device = { id: "uji-1", name: "Scanner Uji" };
    if (url.pathname === "/status") {
      json(200, { ok: true, version: "uji", dpi: 200, scanners: [device], selected: { ...device, feeder: true, feeder_ready: true }, scanner: device.name, feeder_ready: true });
    } else if (url.pathname === "/scan") {
      response.writeHead(200, { ...cors, "content-type": "image/jpeg", "x-scan-seconds": "1.2" });
      response.end(jpeg);
    } else {
      json(404, { ok: false, message: "Endpoint tidak ada." });
    }
  });
  return new Promise((resolve) => server.listen(SCANNER_PORT, "127.0.0.1", () => resolve({ requests, close: () => new Promise((done) => server.close(done)) })));
}

/** A made-up scanned page drawn in the browser, as JPEG bytes in base64. */
const DRAW_SCAN = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 480;
  const pen = canvas.getContext('2d');
  pen.fillStyle = '#ffffff';
  pen.fillRect(0, 0, 360, 480);
  pen.fillStyle = '#222222';
  pen.font = '18px sans-serif';
  pen.fillText('DOKUMEN UJI', 24, 44);
  for (let line = 0; line < 14; line += 1) pen.fillRect(24, 80 + line * 26, 180 + (line % 4) * 30, 8);
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
})()`;

/** Chooses a scanned page in the file picker of the post; the name picks what the mock's reading service answers. */
async function chooseScan(browser, base64, name) {
  await browser.waitFor(`Boolean(document.querySelector('[data-testid="scan-source"] input[type="file"]'))`);
  await browser.evaluate(`(() => {
    const input = document.querySelector('[data-testid="scan-source"] input[type="file"]');
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], ${JSON.stringify(name)}, { type: "image/jpeg" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

async function apiCall(token, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = await response.json();
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${JSON.stringify(answer)}`);
  return answer;
}

const walkInText = textOf('[data-testid="walk-in"]');

/**
 * The owner's flow of 25 November 2026 (API migrations 0016 and 0017): a shipment request sent to a supplier with the
 * contract PDF, the supplier registering on that contract only, a DO sent to its customer and the customer's trucks
 * with the two free texts, and the printed Berita Acara with two signers.
 */
async function shipmentAndCustomer(browser) {
  let adminToken = await apiSession("admin.contoh");
  const requestsBefore = (await apiGet(adminToken, "/api/shipment-requests?limit=50")).total;

  // 60. Staff: a request on the kernel contract of PKS Contoh B, the PDF attached, then sent.
  await staffSignIn(browser, "admin.contoh");
  check("Permintaan pengiriman sits after Registrasi in the staff menu", (await menuLinks(browser)).includes("/registrasi /permintaan-pengiriman /delivery-order"));
  await browser.click('a[href="/permintaan-pengiriman"]');
  check(
    "/permintaan-pengiriman lists the requests with their status",
    Boolean(await browser.waitFor(`location.pathname === '/permintaan-pengiriman' && ${visibleRows} === ${requestsBefore} && ${rowText("0123/CONTOH")}.includes('Terkirim')`)),
  );
  await browser.click("Permintaan baru");
  await pickOption(browser, inSheet('input[name="contractLookup"]'), "0126/CONTOH");
  await pickOption(browser, inSheet('input[name="supplierLookup"]'), "PKS Contoh B");
  await browser.fill(inSheet('input[name="qtyPlanned"]'), "50000");
  await browser.fill(inSheet('input[name="deliveryUntil"]'), isoDate(1));
  await browser.click(inSheet('button[type="submit"]'));
  const requestPath = await browser.waitFor("location.pathname.startsWith('/permintaan-pengiriman/sr-') && location.pathname");
  check(
    "a new request opens as a draft and asks for the contract PDF",
    Boolean(requestPath) &&
      Boolean(await browser.hasText("Permintaan dibuat sebagai draf. Lampirkan PDF kontrak, lalu kirim ke supplier.")) &&
      (await browser.evaluate(textOf('[data-testid="request-facts"]'))).includes("PKS Contoh B"),
  );
  await browser.click("Kirim ke supplier");
  check("only the send sheet is open: the form of the new request closed on the way", (await browser.waitFor(`document.querySelectorAll('[role="dialog"]').length`)) === 1);
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "a request without the PDF is not sent",
    Boolean(await browser.waitFor(`(document.querySelector('[role="dialog"]')?.innerText ?? '').includes('Lampirkan dokumen kontrak sebelum permintaan dikirim.')`)) &&
      (await stat("POST /api/shipment-requests/:id/send")) === 0,
  );
  await browser.pressEscape();
  await browser.waitFor(`!document.querySelector('[role="dialog"]')`);
  await chooseFile(browser, '[data-testid="request-files"]', { name: "kontrak-kernel-uji.pdf", type: "application/pdf", text: PDF_TEXT });
  check(
    "the contract PDF is attached like a DO letter",
    Boolean(await browser.waitFor(`${textOf('[data-testid="request-files"]')}.includes('kontrak-kernel-uji.pdf')`)) && (await stat("POST /api/shipment-requests/:id/files")) === 1,
  );
  await browser.click("Kirim ke supplier");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "the request is sent to the supplier",
    Boolean(await browser.hasText("Permintaan 0126/CONTOH/PK/XI/2026 dikirim ke PKS Contoh B.")) && Boolean(await browser.waitFor(`${textOf("main")}.includes('Terkirim')`)),
  );
  await browser.screenshot("60-permintaan-pengiriman-light");
  await signOut(browser);

  // 61. Supplier: the bell leads to the request, the PDF opens, and the form offers only that contract.
  await partnerSignIn(browser, "pks.contoh.b");
  check("a supplier has Permintaan pengiriman in its menu", (await menuLinks(browser)).includes("/permintaan-pengiriman"));
  await browser.click('[data-testid="notifications-bell"]');
  check(
    "the bell entry of the request leads to its page",
    Boolean(
      await browser.waitFor(`(() => {
        const entry = ${panelEntry("0126/CONTOH/PK/XI/2026")};
        return Boolean(entry) && entry.innerText.includes('Permintaan pengiriman baru') && entry.tagName === 'A' && entry.getAttribute('href') === ${JSON.stringify(requestPath)};
      })()`),
    ),
  );
  await browser.evaluate(`${panelEntry("0126/CONTOH/PK/XI/2026")}.setAttribute('data-smoke', 'follow'); true`);
  await browser.click('[data-smoke="follow"]');
  check(
    "the supplier sees the request with its PDF and a way to register trucks",
    Boolean(await browser.waitFor(`location.pathname === ${JSON.stringify(requestPath)} && ${textOf('[data-testid="request-files"]')}.includes('kontrak-kernel-uji.pdf')`)) &&
      Boolean(await browser.waitFor(`Boolean([...document.querySelectorAll('main a')].find((a) => a.innerText.trim() === 'Daftarkan truk'))`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="request-files"] button[aria-label^="Hapus"]'))`)),
  );
  const supplierToken = await partnerApiSession("pks.contoh.b");
  const pdf = (await apiGet(supplierToken, `/api/shipment-requests/${requestPath.split("/").at(-1)}`)).files?.[0];
  const pdfAnswer = await fetch(`${API}/api/files/${pdf?.id}`, { headers: { authorization: `Bearer ${supplierToken}` } });
  check("the supplier may read the contract PDF", pdfAnswer.status === 200 && (await pdfAnswer.text()).startsWith("%PDF"));
  await browser.click("Daftarkan truk");
  check(
    "the incoming form opens with the contract of the request chosen",
    Boolean(await browser.waitFor(`location.search.includes('kontrak=') && (document.querySelector('[aria-label="Kontrak terpilih"]')?.innerText ?? '').includes('0126/CONTOH/PK/XI/2026')`)),
  );
  await browser.type('input[name="contractLookup"]', "CONTOH");
  check("no other contract is offered: 0125 has no request sent", Boolean(await browser.waitFor(`document.body.innerText.includes('Tidak ada yang cocok.')`)));
  await browser.pressEscape();
  const offered = await apiGet(supplierToken, "/api/contracts?direction=IN&requestSent=true");
  check("the API offers the supplier only the contract with a sent request", offered.items?.map((item) => item.contractNo).join() === "0126/CONTOH/PK/XI/2026");
  await fillTruck(browser, { scope: "main", prefix: "truck", plate: "ZZ 0003 CTH", licence: "CONTOH0002" });
  await browser.click("Kirim registrasi");
  check(
    "the supplier registers a truck on that contract",
    Boolean(await browser.waitFor("location.pathname.startsWith('/registrasi/r-')")) && Boolean(await browser.hasText("0126/CONTOH/PK/XI/2026")),
  );
  const [other] = (await apiGet(supplierToken, "/api/contracts?direction=IN&q=0125/CONTOH")).items;
  const refused = await fetch(`${API}/api/registrations`, {
    method: "POST",
    headers: { authorization: `Bearer ${supplierToken}`, "content-type": "application/json" },
    body: JSON.stringify({ direction: "IN", submit: false, allocations: [{ contractId: other?.id }], trips: [{ vehicle: { id: "v-1" }, driver: { id: "d-1" }, letters: [{ allocationSeq: 1 }] }] }),
  });
  check("a contract INL did not send is refused with SHIPMENT_REQUEST_REQUIRED", refused.status === 409 && (await refused.json()).error?.code === "SHIPMENT_REQUEST_REQUIRED");
  await signOut(browser);

  // 62. Staff send a delivery order to its customer.
  // signing out in the browser ends the sessions of the account, so a new token is taken
  adminToken = await apiSession("admin.contoh");
  // a draft of Customer Contoh A with a complete destination (the DO of step 48 has only a name and a regency)
  const draft = (await apiGet(adminToken, "/api/delivery-orders?status=DRAFT&limit=50")).items.find(
    (order) => order.partner.name === "Customer Contoh A" && order.destination?.address && order.destination.district && order.destination.province,
  );
  const doNo = draft?.doNo ?? "";
  await staffSignIn(browser, "admin.contoh");
  await browser.click('a[href="/delivery-order"]');
  await browser.waitFor(`${rowText(doNo)} !== ''`);
  await browser.click(`button[aria-label="Tindakan ${doNo}"]`);
  await browser.click("Kirim DO");
  await browser.click("Customer");
  check(
    "the send sheet names the customer when Customer is chosen",
    Boolean(await browser.waitFor(`${textOf('[data-testid="send-to-customer"]')}.includes('Customer Contoh A')`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('[role="dialog"] input[name="sendTransporterLookup"]'))`)),
  );
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "the DO is sent to its customer and the list says so",
    Boolean(await browser.hasText(`DO ${doNo} dikirim ke Customer Contoh A.`)) && Boolean(await browser.waitFor(`${rowText(doNo)}.includes('Customer: Customer Contoh A')`)),
  );
  await browser.click(doNo);
  check("the DO page says it went to the customer", Boolean(await browser.waitFor(`${textOf('[data-testid="do-sent-to"]')} === 'Customer: Customer Contoh A'`)));
  await signOut(browser);

  // 63. The customer accepts the DO and registers a truck with the extra SPBE and the passport.
  await partnerSignIn(browser, "customer.contoh");
  const customerMenu = await menuLinks(browser);
  check("a customer account gets Delivery Order and Registrasi", customerMenu.includes("/delivery-order") && customerMenu.includes("/registrasi"), customerMenu);
  await browser.click('a[href="/delivery-order"]');
  await browser.waitFor(`${rowText(doNo)} !== ''`);
  await browser.click(`button[aria-label="Terima ${doNo}"]`);
  await browser.fill(inSheet('input[name="truckCount"]'), "1");
  await browser.click(inSheet('button[type="submit"]'));
  check("the customer accepts the DO", Boolean(await browser.hasText(`DO ${doNo} diterima.`)) && Boolean(await browser.waitFor(`${rowText(doNo)}.includes('Diterima')`)));
  await browser.click(`a[aria-label="Isi daftar truk ${doNo}"]`);
  await browser.waitFor(`document.querySelectorAll('[data-truck]').length === 1`);
  await fillTruck(browser, { scope: '[data-truck="1"]', prefix: "trucks.0", plate: "ZZ 0001 CTH", licence: "CONTOH0001" });
  check(
    "the outgoing form has the two free texts, both optional",
    Boolean(await browser.waitFor(`Boolean(document.querySelector('input[name="trucks.0.extraSpbe"]')) && Boolean(document.querySelector('input[name="trucks.0.passportNo"]'))`)),
  );
  await browser.fill('input[name="trucks.0.extraSpbe"]', "SPBE Uji Satu");
  await browser.fill('input[name="trucks.0.passportNo"]', "SJ-UJI-0001");
  await browser.click("Kirim registrasi");
  check(
    "the customer's truck is saved with the extra SPBE and the passport, and the page shows them",
    Boolean(await browser.waitFor("location.pathname.startsWith('/registrasi/r-')")) &&
      Boolean(await browser.waitFor(`${textOf('[data-testid="trip-1-extra-spbe"]')} === 'SPBE Uji Satu' && ${textOf('[data-testid="trip-1-passport"]')} === 'SJ-UJI-0001'`)),
  );
  const customerToken = await partnerApiSession("customer.contoh");
  const saved = await apiGet(customerToken, `/api/registrations/${(await browser.evaluate("location.pathname")).split("/").at(-1)}`);
  check(
    "the API keeps both texts on the truck",
    saved.registration?.trips?.[0]?.extraSpbe === "SPBE Uji Satu" && saved.registration.trips[0].passportNo === "SJ-UJI-0001" && saved.registration.transporter?.name === "Customer Contoh A",
  );
  await browser.screenshot("63-customer-truk-light");
  await signOut(browser);

  // 64. The Berita Acara print: the title of the API, the plates of a plate report, two signers only.
  adminToken = await apiSession("admin.contoh");
  const listed = (await apiGet(adminToken, "/api/exceptions?limit=50")).items;
  const net = listed.find((item) => item.type === "NET_IN" && item.reportNo);
  let plate = listed.find((item) => item.type === "PLATE" && item.status === "PENDING");
  if (plate) plate = (await apiCall(adminToken, "POST", `/api/exceptions/${plate.id}/decide`, { decision: "APPROVE" })).exception;
  else plate = listed.find((item) => item.type === "PLATE" && item.reportNo);
  await staffSignIn(browser, "admin.contoh");
  await browser.goto(`${WEB}/berita-acara/${encodeURIComponent(net?.id ?? "")}`);
  const signers = `[...document.querySelectorAll('[data-testid="report-signer"]')].map((node) => node.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')`;
  check(
    "the Berita Acara has the title of the API and exactly two signers: the post operator and the approver",
    Boolean(await browser.waitFor(`${textOf('[data-testid="report-title"]')} === 'Berita Acara Selisih Netto'`)) &&
      (await browser.evaluate(signers)) === "Dibuat oleh Petugas Pos Contoh Operator registrasi | Disetujui oleh Admin Contoh Penyetuju" &&
      !(await browser.evaluate("document.body.innerText.includes('Diketahui')")),
    await browser.evaluate(signers),
  );
  check("a weight report lists the weights", (await browser.evaluate(textOf('[data-testid="report-figures"]'))).includes("Netto surat"));
  await browser.screenshot("64-berita-acara-light");
  await browser.goto(`${WEB}/berita-acara/${encodeURIComponent(plate?.id ?? "")}`);
  check(
    "a plate report names the plate read and the registered plate",
    Boolean(await browser.waitFor(`${textOf('[data-testid="report-title"]')} === 'Berita Acara Plat Tidak Sesuai'`)) &&
      Boolean(await browser.waitFor(`${textOf('[data-testid="report-figures"]')}.includes('Plat terbaca kamera ZZ0002CTN') && ${textOf('[data-testid="report-figures"]')}.includes('Plat terdaftar ZZ 0002 CTH')`)) &&
      (await browser.evaluate(`document.querySelectorAll('[data-testid="report-signer"]').length`)) === 2 &&
      String(plate?.reportNo ?? "").includes("BA-PLAT"),
  );
  await browser.goto(`${WEB}/`);
  await signOut(browser);
}

/**
 * Several mills on one trader's contract (owner, 26 November 2026; API migration 0018): the admin adds a mill together
 * with its first account on the Pengguna page; staff ask 3.000 t, 2.000 t and 5.000 t of the trader's 10.000 t contract
 * from three mills, and a fourth request is refused; the mill sees its own request and registers a truck with itself
 * as asal PKS. Traders have no account, so no screen of a trader is checked.
 */
async function millRequests(browser) {
  const TRADER_CONTRACT = "0130/CONTOH/CPO/XI/2026";

  // 70. The admin makes a mill and its first account together.
  await staffSignIn(browser, "super.contoh");
  await browser.goto(`${WEB}/pengguna`);
  await browser.click("Akun partner");
  await browser.fill(inSheet('input[name="newPartnerName"]'), "PKS Contoh Lestari");
  await browser.fill(inSheet('input[name="accountFullName"]'), "Admin PKS Lestari");
  await browser.fill(inSheet('input[name="accountUsername"]'), "pks.lestari");
  await browser.fill(inSheet('input[name="accountPassword"]'), "contoh-123");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "the admin makes a new mill and its first account in one go",
    Boolean(await browser.hasText("PKS Contoh Lestari dan akun pks.lestari dibuat.")) && Boolean(await browser.waitFor(`${rowText("pks.lestari")}.includes('PKS Contoh Lestari')`)),
  );
  await browser.click("Akun partner");
  await browser.fill(inSheet('input[name="newPartnerName"]'), " pks contoh lestari ");
  await browser.fill(inSheet('input[name="accountFullName"]'), "Admin Kedua Lestari");
  await browser.fill(inSheet('input[name="accountUsername"]'), "pks.lestari2");
  await browser.fill(inSheet('input[name="accountPassword"]'), "contoh-123");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "a mill name already there is not made twice: the form picks that mill instead",
    Boolean(await browser.waitFor(`(document.querySelector('[role="dialog"]')?.innerText ?? '').includes('PKS dengan nama ini sudah ada.')`)) &&
      Boolean(await browser.waitFor(`Boolean(document.querySelector('[role="dialog"] input[name="accountPartnerLookup"]'))`)),
  );
  await browser.click(inSheet('button[type="submit"]'));
  check("saving again makes only the second account of that mill", Boolean(await browser.hasText("Akun pks.lestari2 untuk PKS Contoh Lestari dibuat.")));
  await browser.screenshot("70-akun-pks-baru-light");
  const admin = await apiSession("super.contoh");
  for (const [name, username] of [["PKS Contoh Melati", "pks.melati"], ["PKS Contoh Kenanga", "pks.kenanga"]]) {
    await apiCall(admin, "POST", "/api/admin/users", { username, fullName: `Admin ${name}`, password: "contoh-123", newPartner: { name } });
  }
  const millId = async (name) => (await apiGet(admin, `/api/partners?role=supplier&q=${encodeURIComponent(name)}`)).items?.[0]?.id;
  const [trader] = (await apiGet(admin, `/api/contracts?direction=IN&q=${encodeURIComponent(TRADER_CONTRACT)}`)).items;
  await apiCall(admin, "POST", "/api/shipment-requests", { contractId: trader.id, supplierId: await millId("Melati"), qtyPlanned: 2000000 });
  await apiCall(admin, "POST", "/api/shipment-requests", { contractId: trader.id, supplierId: await millId("Kenanga"), qtyPlanned: 5000000 });

  // 71. Staff ask the third mill for 3.000 t; the contract is then fully asked for, and a fourth request is refused.
  await browser.goto(`${WEB}/permintaan-pengiriman`);
  await browser.click("Permintaan baru");
  await pickOption(browser, inSheet('input[name="contractLookup"]'), TRADER_CONTRACT);
  check(
    "the request form tells the contract quantity and what other mills are already asked for",
    Boolean(await browser.waitFor(`${textOf('[data-testid="contract-requested"]')} === 'Kontrak 10.000.000 Kg · sudah diminta 7.000.000 Kg · sisa 3.000.000 Kg'`)),
    await browser.evaluate(textOf('[data-testid="contract-requested"]')),
  );
  await pickOption(browser, inSheet('input[name="supplierLookup"]'), "PKS Contoh Lestari");
  await browser.fill(inSheet('input[name="qtyPlanned"]'), "3000000");
  await browser.click(inSheet('button[type="submit"]'));
  const lestariPath = await browser.waitFor("location.pathname.startsWith('/permintaan-pengiriman/sr-') && location.pathname");
  check(
    "the request names the mill and the trader apart",
    Boolean(lestariPath) &&
      Boolean(await browser.waitFor(`${textOf('[data-testid="request-facts"]')}.includes('PKS pengirim PKS Contoh Lestari') && ${textOf('[data-testid="request-facts"]')}.includes('Partner kontrak Pedagang Contoh A')`)),
    await browser.evaluate(textOf('[data-testid="request-facts"]')),
  );
  check(
    "the request page lists every request of the contract, one per mill",
    Boolean(
      await browser.waitFor(`(() => {
        const text = ${textOf('[data-testid="contract-requests"]')};
        return text.includes('Permintaan untuk kontrak ini (3)') && text.includes('PKS Contoh Melati') && text.includes('PKS Contoh Kenanga') && text.includes('3.000.000 Kg');
      })()`),
    ),
  );
  await browser.goto(`${WEB}/permintaan-pengiriman`);
  await browser.click("Permintaan baru");
  await pickOption(browser, inSheet('input[name="contractLookup"]'), TRADER_CONTRACT);
  await pickOption(browser, inSheet('input[name="supplierLookup"]'), "PKS Contoh B");
  await browser.fill(inSheet('input[name="qtyPlanned"]'), "1");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "a fourth request above the contract is refused with the numbers",
    Boolean(
      await browser.waitFor(
        `(document.querySelector('[role="dialog"]')?.innerText ?? '').includes('Permintaan 1 Kg melebihi sisa kontrak ${TRADER_CONTRACT}: quantity kontrak 10000000 Kg, sudah diminta 10000000 Kg, sisa 0 Kg.')`,
      ),
    ),
  );
  await browser.screenshot("71-permintaan-lebih-dari-kontrak-light");
  await browser.pressEscape();
  await browser.goto(`${WEB}${lestariPath}`);
  await chooseFile(browser, '[data-testid="request-files"]', { name: "kontrak-pedagang-uji.pdf", type: "application/pdf", text: PDF_TEXT });
  await browser.waitFor(`${textOf('[data-testid="request-files"]')}.includes('kontrak-pedagang-uji.pdf')`);
  await browser.click("Kirim ke supplier");
  await browser.click(inSheet('button[type="submit"]'));
  check("the request goes to the mill, not to the trader", Boolean(await browser.hasText(`Permintaan ${TRADER_CONTRACT} dikirim ke PKS Contoh Lestari.`)));
  await signOut(browser);

  // 72. The mill sees its own request only and registers a truck with itself as asal PKS.
  await partnerSignIn(browser, "pks.lestari");
  await browser.click('a[href="/permintaan-pengiriman"]');
  check(
    "the mill lists only the request sent to it",
    Boolean(await browser.waitFor(`location.pathname === '/permintaan-pengiriman' && ${visibleRows} === 1 && ${rowText(TRADER_CONTRACT)}.includes('3.000.000')`)),
  );
  const mill = await partnerApiSession("pks.lestari");
  const offered = await apiGet(mill, "/api/contracts?direction=IN&requestSent=true");
  check(
    "the API offers the mill the trader's contract with its own request and quantity",
    offered.items?.length === 1 && offered.items[0].contractNo === TRADER_CONTRACT && offered.items[0].shipmentRequest?.qtyPlanned === 3000000 && offered.items[0].requests === null,
  );
  await browser.goto(`${WEB}${lestariPath}`);
  await browser.click("Daftarkan truk");
  check(
    "the incoming form shows the mill as asal PKS, taken from the account",
    Boolean(await browser.waitFor(`${textOf('[data-testid="origin-own"]')}.includes('PKS Contoh Lestari')`)),
  );
  await fillTruck(browser, { scope: "main", prefix: "truck", plate: "ZZ 0031 PKS", licence: "CONTOH0310", newVehicle: { type: "TANGKI" }, newDriver: { fullName: "Supir PKS Lestari" } });
  await browser.click("Kirim registrasi");
  check(
    "the registration keeps the trader as partner and the mill as asal PKS",
    Boolean(await browser.waitFor("location.pathname.startsWith('/registrasi/r-')")) &&
      Boolean(await browser.waitFor(`${pageText}.includes('Asal PKS PKS Contoh Lestari') && ${pageText}.includes('Partner Pedagang Contoh A')`)),
  );
  await browser.screenshot("72-registrasi-asal-pks-light");
  const others = await apiGet(await partnerApiSession("pks.melati"), "/api/registrations?direction=IN");
  check("another mill does not see that truck", others.total === 0);
  await signOut(browser);
}

/**
 * A registration changed after it was sent (owner, 26 November 2026): the transporter's truck that checked in is
 * locked and says why, the other one changes its vehicle and gets a new SPJ to print, and the old barcode stops at
 * the post. Staff with registrations EDIT get the same button; staff with CREATE do not.
 */
async function changeAfterSend(browser) {
  const admin = await apiSession("admin.contoh");
  const transporter = await partnerApiSession("transporter.contoh");
  const ofTransporter = (item) => item.transporter?.name === "Transporter Contoh A";
  let order = (await apiGet(transporter, "/api/delivery-orders?status=ACCEPTED&limit=50")).items.find((item) => ofTransporter(item) && item.qtyRemaining >= 20000);
  if (!order) {
    // a fresh mock: the DO sent to the transporter is accepted first
    order = (await apiGet(transporter, "/api/delivery-orders?status=SENT&limit=50")).items.find((item) => ofTransporter(item) && item.qtyRemaining >= 20000);
    await apiCall(transporter, "POST", `/api/delivery-orders/${order?.id}/accept`, { truckCount: 2 });
  }
  const newTruck = (plate, licence, name) => ({
    vehicle: { plateDisplay: plate, vehicleTypeCode: "TANGKI" },
    driver: { licenceNo: licence, fullName: name, licenceClass: "B2 UMUM", licenceValidUntil: isoDate(2) },
  });
  const made = await apiCall(transporter, "POST", "/api/registrations", {
    direction: "OUT",
    submit: true,
    allocations: [{ deliveryOrderId: order?.id, qtyPlanned: 20000 }],
    trips: [newTruck("ZZ 0041 UBH", "CONTOH0411", "Supir Ubah Satu"), newTruck("ZZ 0042 UBH", "CONTOH0412", "Supir Ubah Dua")],
  });
  const id = made.registration.id;
  if (made.registration.status === "SUBMITTED") await apiCall(admin, "POST", `/api/registrations/${id}/approve`, {});
  const approved = (await apiGet(transporter, `/api/registrations/${id}`)).registration;
  const [first, second] = approved.trips;
  const card = (await apiGet(admin, "/api/rfid-cards?status=AVAILABLE&limit=1")).items[0];
  await apiCall(admin, "POST", "/api/gate/check-in", { token: first.spj.barcodeToken, cardUid: card.uid, closeCargo: false, flexiBag: false });
  const oldToken = second.spj.barcodeToken;

  // 73. The transporter sees which truck is locked and why, and changes the other one.
  await partnerSignIn(browser, "transporter.contoh");
  await browser.goto(`${WEB}/registrasi/${encodeURIComponent(id)}`);
  check(
    "a sent registration offers Ubah and says which truck is locked and why",
    Boolean(await browser.waitFor(`Boolean(document.querySelector('[data-testid="change-sent"]'))`)) &&
      Boolean(await browser.waitFor(`${textOf('[data-testid="trip-1-locked"]')} === 'Tidak bisa diubah: truk sudah check-in di pos.'`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="trip-2-locked"]'))`)),
  );
  await browser.click('[data-testid="change-sent"]');
  check(
    "the form leaves the truck that checked in out and says so",
    Boolean(await browser.waitFor(`location.pathname.endsWith('/ubah') && document.querySelectorAll('[data-truck]').length === 1`)) &&
      Boolean(await browser.waitFor(`${textOf('[data-testid="sent-edit-notice"]')}.includes('Truk 1 (ZZ 0041 UBH) sudah check-in di pos')`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('button[aria-label^="Hapus DO"]'))`)) &&
      !(await browser.evaluate(`[...document.querySelectorAll('button')].some((button) => button.innerText.trim() === 'Simpan draf')`)),
  );
  await fillTruck(browser, { scope: '[data-truck="1"]', prefix: "trucks.0", plate: "ZZ 0043 UBH", licence: "CONTOH0412", newVehicle: { type: "TANGKI" } });
  await browser.click("Simpan perubahan");
  check(
    "after a vehicle change the page tells to print the new SPJ of that truck",
    Boolean(await browser.waitFor(`location.pathname === ${JSON.stringify(`/registrasi/${id}`)}`)) &&
      Boolean(await browser.hasText("Truk 2 punya SPJ baru. Cetak SPJ-nya untuk supir; SPJ lama tidak berlaku lagi di pos.")),
  );
  await browser.screenshot("73-ubah-setelah-kirim-light");
  const changed = (await apiGet(transporter, `/api/registrations/${id}`)).registration;
  const oldAtGate = await fetch(`${API}/api/gate/check-in`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ token: oldToken, cardUid: card.uid, closeCargo: false, flexiBag: false }),
  });
  check(
    "the old barcode is refused at the post and the truck carries the new plate",
    oldAtGate.status === 409 && (await oldAtGate.json()).error?.code === "SPJ_REVOKED" && changed.trips[1]?.vehicle?.plateDisplay === "ZZ 0043 UBH" && changed.trips[1].spj?.barcodeToken !== oldToken,
  );
  await signOut(browser);

  // 74. Staff with registrations EDIT may change it too; the desk with CREATE may not.
  await staffSignIn(browser, "admin.contoh");
  await browser.goto(`${WEB}/registrasi/${encodeURIComponent(id)}`);
  const staffSees = Boolean(await browser.waitFor(`Boolean(document.querySelector('[data-testid="change-sent"]'))`));
  await signOut(browser);
  await staffSignIn(browser, "pos.contoh");
  await browser.goto(`${WEB}/registrasi/${encodeURIComponent(id)}`);
  await browser.waitFor(`document.body.innerText.includes(${JSON.stringify(approved.regNo)})`);
  check("staff with EDIT get Ubah on a sent registration, the desk with CREATE does not", staffSees && !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="change-sent"]'))`)));
  await signOut(browser);
}

async function postWithoutBarcode(browser) {
  // Setup through the API: a delivery order with room for more trucks, and one bulk truck registered ahead without
  // the two marks, the way a transporter now registers.
  const admin = await apiSession("admin.contoh");
  const [sales] = (await apiCall(admin, "GET", "/api/contracts?direction=OUT&q=0046/CONTOH")).items;
  const { deliveryOrder } = await apiCall(admin, "POST", "/api/delivery-orders", {
    contractId: sales.id,
    qty: 60000,
    transporterId: "p-301",
    doDate: new Date().toISOString().slice(0, 10),
    deliveryFrom: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    destName: "Gudang Uji Pos",
    destAddress: "Jalan Uji No. 9",
    destDistrict: "Kecamatan Uji",
    destRegency: "Kota Uji",
    destProvince: "Provinsi Uji",
  });
  await apiCall(admin, "POST", `/api/delivery-orders/${deliveryOrder.id}/send`, {});
  await apiCall(admin, "POST", `/api/delivery-orders/${deliveryOrder.id}/accept`, { truckCount: 3 });
  const ahead = (
    await apiCall(admin, "POST", "/api/registrations", {
      direction: "OUT",
      submit: true,
      allocations: [{ deliveryOrderId: deliveryOrder.id, qtyPlanned: 5000 }],
      trips: [
        {
          vehicle: { plateDisplay: "ZZ 9203 UJI", vehicleTypeCode: "TANGKI" },
          driver: { licenceNo: "UJI9203", fullName: "Supir Uji Sembilan", licenceClass: "B2 UMUM", licenceValidUntil: isoDate(2) },
        },
      ],
    })
  ).registration;
  const token = ahead.trips[0]?.spj?.barcodeToken ?? "";
  const scanJpeg = await browser.evaluate(DRAW_SCAN);

  // 50. Barcode check-in of a bulk outgoing truck: the post marks close cargo and flexi bag before the card.
  await staffSignIn(browser, "pos.contoh");
  await browser.goto(`${WEB}/registrasi/${ahead.id}`);
  check(
    "the registration detail shows close cargo and flexi bag per truck as not marked yet",
    Boolean(await browser.waitFor(`${textOf("main li[data-trip-seq]")}.includes('Close cargo belum ditandai') && ${textOf("main li[data-trip-seq]")}.includes('Flexi bag belum ditandai')`)),
  );
  await browser.goto(`${WEB}/registrasi`);
  await browser.waitFor(`location.pathname === '/registrasi' && ${visibleRows} > 0`);
  check(
    "staff get no button that opens the typed registration form",
    !(await browser.evaluate("document.body.innerText.includes('Registrasi incoming') || document.body.innerText.includes('Registrasi outgoing')")),
  );
  await browser.goto(`${WEB}/registrasi/baru?arah=in`);
  check("staff opening the typed form are sent to the post", Boolean(await browser.hasText("Truk yang datang tanpa barcode didaftarkan di Pos registrasi lewat scan dokumen.")));
  await browser.goto(`${WEB}/pos`);
  await browser.waitFor("document.activeElement?.id === 'gate-scan'");
  await browser.typeFocused(token);
  await browser.pressEnter();
  check(
    "the scan of a bulk outgoing SPJ asks for both marks first, with nothing chosen",
    Boolean(
      await browser.waitFor(
        `Boolean(document.querySelector('[data-testid="gate-marks"]')) && !document.querySelector('#gate-card') && document.activeElement?.name === 'closeCargo' && !document.querySelector('[data-testid="gate-marks"] input:checked')`,
      ),
    ),
  );
  await browser.screenshot("50-pos-tanda-muatan-light");
  await browser.click('[data-testid="gate-marks"] label:has(input[name="closeCargo"][value="yes"])');
  check("one answer is not enough for the card", !(await browser.evaluate("Boolean(document.querySelector('#gate-card'))")));
  await browser.click('[data-testid="gate-marks"] label:has(input[name="flexiBag"][value="no"])');
  check("both answers open the card box with focus", Boolean(await browser.waitFor("document.activeElement?.id === 'gate-card'")));
  const checkIns = await stat("POST /api/gate/check-in");
  await browser.typeFocused("04a1b2c301");
  await browser.pressEnter();
  check(
    "the truck checks in with the marks the post chose",
    Boolean(await browser.waitFor(`${textOf('[data-testid="gate-success"]')}.includes('Close cargo: ya. Flexi bag: tidak.')`)) && (await waitStat("POST /api/gate/check-in", checkIns + 1)),
  );
  const marked = (await apiCall(admin, "GET", `/api/registrations/${ahead.id}`)).registration.trips[0];
  check("the API keeps the marks on the truck", marked.closeCargo === true && marked.flexiBag === false, JSON.stringify([marked.closeCargo, marked.flexiBag]));
  await browser.goto(`${WEB}/registrasi/${ahead.id}`);
  check("the registration detail shows the marks of the truck", Boolean(await browser.waitFor(`${textOf("main li[data-trip-seq]")}.includes('Close cargo Ya') && ${textOf("main li[data-trip-seq]")}.includes('Flexi bag Tidak')`)));

  // 51. Without a barcode, as an operator without emergency access: the helper is off, the reading service is down.
  await browser.goto(`${WEB}/pos`);
  await browser.click("Tanpa barcode");
  check(
    "a helper that does not answer is said plainly, and the file picker is offered",
    Boolean(await browser.waitFor(`${textOf('[data-testid="scanner-status"]')}.includes('Pembantu scanner di PC ini tidak menjawab') && ${walkInText}.includes('Pilih berkas scan')`)) &&
      (await browser.evaluate(`document.querySelector('[data-testid="scan-source"] button')?.disabled === true`)),
  );
  check(
    "an operator without emergency access gets no typed registration without a scan",
    !(await browser.evaluate(`${walkInText}.includes('Registrasi darurat tanpa scan')`)) &&
      (await browser.evaluate(`${walkInText}.includes('Registrasi tanpa scan hanya untuk petugas dengan akses registrasi darurat.')`)),
  );
  await chooseScan(browser, scanJpeg, "surat-rusak.jpg");
  check(
    "a reading service that is down is said plainly, with what to do without emergency access",
    Boolean(
      await browser.waitFor(
        `${textOf('[data-testid="walk-in-failed"]')}.includes('Layanan baca dokumen tidak bisa dihubungi.') && ${textOf('[data-testid="walk-in-failed"]')}.includes('Pindai lagi, atau panggil petugas dengan akses registrasi darurat.')`,
      ),
    ) && !(await browser.evaluate(`${textOf('[data-testid="walk-in-failed"]')}.includes('Registrasi darurat')`)),
  );
  await browser.screenshot("51-pos-layanan-mati-light");
  await browser.click("Pindai lagi");
  await chooseScan(browser, scanJpeg, "surat-buram.jpg");
  check(
    "an unreadable letter shows what was read, and only asks to scan again",
    Boolean(await browser.waitFor(`${walkInText}.includes('Dokumen ini tidak terbaca dengan baik. Pindai lagi, atau panggil petugas dengan akses registrasi darurat.') && ${textOf('[data-testid="walk-in-read"]')}.includes('5 dari 12 isian ditemukan')`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="walk-in-form"]'))`)),
  );
  await browser.click("Pindai lagi");

  // 52. The scanner helper answers: an incoming letter is scanned, read cleanly, and the truck checks in.
  const scanner = await startFakeScanner(Buffer.from(scanJpeg, "base64"));
  try {
    await browser.click("Periksa scanner");
    check(
      "the helper of the old application is found at its address",
      Boolean(await browser.waitFor(`${textOf('[data-testid="scanner-status"]')}.includes('Scanner siap: Scanner Uji')`)),
      scanner.requests.join(", ") || `nothing reached ${SCANNER}; rebuild with NEXT_PUBLIC_SCANNER_URL=${SCANNER}`,
    );
    await browser.click("Pindai dengan scanner");
    check(
      "the page is read through a plain GET of the helper, without a preflight",
      Boolean(await browser.waitFor(`Boolean(document.querySelector('[data-testid="walk-in-read"]'))`)) &&
        scanner.requests.some((line) => line.startsWith("GET /scan?dpi=200&device=uji-1")) &&
        !scanner.requests.some((line) => line.startsWith("OPTIONS")),
      scanner.requests.join(", "),
    );
  } finally {
    await scanner.close();
  }
  check(
    "the proposal shows the scan beside what was read, and every match found",
    Boolean(await browser.waitFor(`document.querySelector('[data-testid="walk-in-scan"]')?.naturalWidth > 0`)) &&
      Boolean(await browser.waitFor(`${textOf('[data-testid="walk-in-read"]')}.includes('12 dari 12 isian ditemukan')`)) &&
      (await browser.evaluate(`['match-supplier', 'match-contract-1', 'match-vehicle', 'match-driver'].every((id) => document.querySelector('[data-testid="' + id + '"]')?.dataset.status === 'EXACT')`)) &&
      !(await browser.evaluate(`Boolean(document.querySelector('[data-testid="walk-in-todo"]'))`)),
  );
  check(
    "the plate and the licence of the letter are looked up as typed ones are",
    Boolean(await browser.waitFor(`${walkInText}.includes('Surat kendaraan') && ${walkInText}.includes('Supir Contoh 02')`)) &&
      (await browser.evaluate(`document.querySelector('input[name="letters.0.originNetKg"]')?.value === '24090'`)),
  );
  await browser.screenshot("52-pos-usulan-masuk-light");
  await browser.click("Lanjut: tempel kartu");
  await browser.waitFor("document.activeElement?.id === 'walk-in-card'");
  const walkIns = await stat("POST /api/gate/walk-in");
  await browser.typeFocused("04a1b2c302");
  await browser.pressEnter();
  check(
    "a walk-in from a read letter checks the truck in at once",
    Boolean(await browser.waitFor(`${textOf('[data-testid="walk-in-done"]')}.includes('Check-in berhasil') && ${textOf('[data-testid="walk-in-done"]')}.includes('ZZ 0001 CTH') && ${textOf('[data-testid="walk-in-done"]')}.includes('dibuat dari scan dokumen')`)) &&
      (await waitStat("POST /api/gate/walk-in", walkIns + 1)),
  );
  await browser.screenshot("53-pos-walk-in-masuk-light");

  // 53. A letter whose driver has a warning: registered, but waiting for logistics, and no card used.
  await browser.click("Truk berikutnya");
  await chooseScan(browser, scanJpeg, "surat-warning.jpg");
  await browser.waitFor(`${walkInText}.includes('Supir ini berstatus Warning di VCF.') && ${walkInText}.includes('Surat kendaraan')`);
  await browser.click("Lanjut: tempel kartu");
  await browser.waitFor("document.activeElement?.id === 'walk-in-card'");
  await browser.typeFocused("04a1b2c303");
  await browser.pressEnter();
  check(
    "a walk-in with a finding says plainly that it waits for review and the card is not used",
    Boolean(
      await browser.waitFor(
        `${textOf('[data-testid="walk-in-review"]')}.includes('Menunggu tinjauan logistik') && ${textOf('[data-testid="walk-in-review"]')}.includes('Truk belum check-in dan kartu belum dipakai.') && ${textOf('[data-testid="walk-in-review"]')}.includes('berstatus peringatan di VCF')`,
      ),
    ) && (await apiCall(admin, "GET", "/api/rfid-cards")).items.find((card) => card.uid === "04A1B2C303")?.status === "AVAILABLE",
  );
  await browser.screenshot("54-pos-walk-in-tinjauan-light");

  // 54. An outgoing delivery order on a phone: the operator picks the truck, the quantity and both marks.
  await browser.click("Truk berikutnya");
  await browser.viewport(390, 844, true);
  await browser.click('[data-testid="walk-in"] [role="group"][aria-label="Arah truk"] button:nth-child(2)');
  await chooseScan(browser, scanJpeg, "do-keluar.jpg");
  check(
    "the scanned delivery order is found, and the truck, the quantity and both marks are listed as open",
    Boolean(await browser.waitFor(`document.querySelector('[data-testid="match-order"]')?.dataset.status === 'EXACT'`)) &&
      (await browser.evaluate(`document.querySelectorAll('[data-testid="walk-in-todo"] li[data-done="0"]').length === 5`)),
  );
  check("the walk-in form has no horizontal scroll on a phone", await browser.evaluate(noHorizontalScroll));
  await browser.screenshot("55-pos-walk-in-keluar-phone-light");
  await browser.fill('input[name="qty"]', "12000");
  await fillTruck(browser, { scope: '[data-testid="walk-in"]', prefix: "truck", plate: "ZZ 9201 UJI", licence: "CONTOH0001", newVehicle: { type: "TANGKI" } });
  await browser.click('label:has(input[name="walkIn.closeCargo"][value="yes"])');
  await browser.click('label:has(input[name="walkIn.flexiBag"][value="no"])');
  check("every open item is ticked off as the form fills", Boolean(await browser.waitFor(`document.querySelectorAll('[data-testid="walk-in-todo"] li[data-done="1"]').length === 5`)));
  await browser.viewport(1366, 900);
  await browser.click("Lanjut: tempel kartu");
  await browser.waitFor("document.activeElement?.id === 'walk-in-card'");
  await browser.typeFocused("04a1b2c304");
  await browser.pressEnter();
  check(
    "an outgoing walk-in checks the truck in with the marks of the post",
    Boolean(await browser.waitFor(`${textOf('[data-testid="walk-in-done"]')}.includes('ZZ 9201 UJI') && ${textOf('[data-testid="walk-in-done"]')}.includes('Close cargo: ya. Flexi bag: tidak.')`)),
  );
  await browser.goto(`${WEB}/`);
  await signOut(browser);

  // 55. The reading service is down, as an officer with emergency access: the same form by hand, with a reason.
  await staffSignIn(browser, "admin.contoh");
  await browser.goto(`${WEB}/pos`);
  await browser.click("Tanpa barcode");
  check("an officer with emergency access may register without a scan", Boolean(await browser.waitFor(`${walkInText}.includes('Registrasi darurat tanpa scan')`)));
  await chooseScan(browser, scanJpeg, "surat-rusak.jpg");
  check(
    "after the service fails, the officer is offered the emergency registration",
    Boolean(await browser.waitFor(`${textOf('[data-testid="walk-in-failed"]')}.includes('Isi datanya dengan tangan dan tulis alasannya')`)),
  );
  await browser.click("Registrasi darurat");
  await browser.waitFor(`Boolean(document.querySelector('[data-testid="walk-in-emergency"]'))`);
  await pickOption(browser, 'input[name="walkInContractLookup"]', "0125/CONTOH");
  await browser.fill('input[name="letters.0.originNetKg"]', "21000");
  await fillTruck(browser, { scope: '[data-testid="walk-in"]', prefix: "truck", plate: "ZZ 9202 UJI", licence: "UJI9202", newVehicle: { type: "TANGKI" }, newDriver: { fullName: "Supir Uji Darurat" } });
  await browser.click("Lanjut: tempel kartu");
  check("the emergency registration needs a reason", Boolean(await browser.hasText("Tulis alasan registrasi darurat.")) && !(await browser.evaluate("Boolean(document.querySelector('#walk-in-card'))")));
  await browser.fill('textarea[name="reason"]', "Layanan baca dokumen mati");
  await browser.screenshot("56-pos-darurat-light");
  await browser.click("Lanjut: tempel kartu");
  await browser.waitFor("document.activeElement?.id === 'walk-in-card'");
  await browser.typeFocused("04a1b2c303");
  await browser.pressEnter();
  check(
    "the emergency registration checks the truck in and says it was recorded as one",
    Boolean(await browser.waitFor(`${textOf('[data-testid="walk-in-done"]')}.includes('ZZ 9202 UJI') && ${textOf('[data-testid="walk-in-done"]')}.includes('dicatat sebagai registrasi darurat')`)),
  );
  await browser.goto(`${WEB}/`);
  await signOut(browser);
}

async function waitStat(route, count) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await stat(route)) >= count) return true;
    await sleep(100);
  }
  return false;
}

// --- main -------------------------------------------------------------------

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
  start(process.execPath, ["dev/mock-api.mjs"], {
    env: { ...process.env, PORT: String(API_PORT), WEB_ORIGIN: WEB, MOCK_SYNC_MS: "400" },
  });
  start(process.execPath, ["node_modules/next/dist/bin/next", DEV_MODE ? "dev" : "start", "-p", String(WEB_PORT)], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...(DEV_MODE ? { NEXT_PUBLIC_API_URL: API, NEXT_PUBLIC_SCANNER_URL: SCANNER } : {}) },
  });
  await waitForHttp(`${API}/api/health`, "mock API");
  await waitForHttp(`${WEB}/login`, "web app");

  browser = await Browser.launch(executable, { profileDir: path.join(outDir, "profile"), outDir, waitMs: WAIT_MS, spawnChild: start });
  await browser.openPage();
  tilesServed = await browser.serveMapTilesFrom(`${API}/__mock/tile/`);
  await run(browser);
} catch (error) {
  failure = error;
  if (browser) await browser.screenshot("failure").catch(() => {});
} finally {
  if (browser) await browser.close();
  for (const child of children) child.kill();
  // The browser can hold files in its profile for a moment after it exits; retry until they are gone.
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
if (failure) console.error(`Stopped early: ${failure.message}`);
process.exit(failure || failed > 0 ? 1 : 0);
