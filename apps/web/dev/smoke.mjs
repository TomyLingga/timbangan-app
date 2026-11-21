// End-to-end smoke check of the built app against dev/mock-api.mjs, driven
// through a headless Edge or Chrome over the DevTools protocol. No dependencies.
//
//   NEXT_PUBLIC_API_URL=http://localhost:3110 npm run build
//   node dev/smoke.mjs
//
// The script starts the mock API and `next start` on its own ports, so it does
// not collide with a real API on 3100 or a dev server on 3000. Screenshots go
// to dev/.smoke/. Exit code 0 means every check passed.

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, findBrowser, sleep, waitForHttp } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dev", ".smoke");
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 3210);
const API_PORT = Number(process.env.SMOKE_API_PORT ?? 3110);
const WEB = `http://localhost:${WEB_PORT}`;
const API = `http://localhost:${API_PORT}`;
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
  check("exchange was called once for the root landing", (await stat("POST /api/auth/sso/exchange")) === 1);

  // 10. Admin: sync button, counts, list reload, Outgoing tab.
  await browser.click('a[href="/kontrak"]');
  const adminRows = await browser.waitFor(visibleRows);
  check("admin sees all open incoming contracts", adminRows === 5, `${adminRows} rows`);
  await browser.screenshot("03-kontrak-admin-light");
  await browser.click("Ambil dari Odoo");
  const summary = await browser.waitFor("[...document.querySelectorAll('p')].find((p) => p.innerText.startsWith('Selesai dalam'))?.innerText", 10000);
  check("sync shows duration and counts", Boolean(summary) && summary.includes("13 kontrak") && summary.includes("Dilewati: 1."), summary ?? "no summary");
  check("list reloads after the sync", (await browser.waitFor(`${visibleRows} === 6 && ${visibleRows}`)) === 6);
  await browser.click("Outgoing (penjualan)");
  check("Outgoing tab shows sales contracts with the customer PO", Boolean(await browser.waitFor(`${visibleRows} === 4`)) && Boolean(await browser.hasText("PO PO-CONTOH-0012")));
  await browser.goto(`${WEB}/`);
  check("Beranda shows the last sync per data set", Boolean(await browser.hasText("Berhasil")) && Boolean(await browser.hasText("13 baris")));
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
  check("phone width shows cards instead of the table", cards === 6 && (await browser.evaluate(visibleRows)) === 0, `${cards} cards`);
  check("phone width has no horizontal scroll", await browser.evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
  await browser.screenshot("06-kontrak-phone-dark");
  await browser.click('button[aria-label="Buka menu"]');
  check("drawer lists the pages of a logistics admin and Denah without a link", Boolean(await browser.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const links = [...dialog.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    // Every page but Pengguna for a logistics admin; Denah comes later and is plain text.
    const expected = ['/', '/registrasi', '/delivery-order', '/pos', '/kontrak', '/supir', '/kendaraan', '/tujuan', '/kartu'];
    return dialog.innerText.includes('Denah') && !links.includes('/denah') && links.join() === expected.join();
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
  check("menu has Supir, Kendaraan and Tujuan but no Pengguna for a logistics admin", await browser.evaluate(`(() => {
    const links = [...document.querySelectorAll('aside nav a')].map((a) => a.getAttribute('href'));
    return ['/supir', '/kendaraan', '/tujuan'].every((href) => links.includes(href)) && !links.includes('/pengguna');
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

  // 17. Tujuan: customer filter, create.
  await browser.goto(`${WEB}/tujuan`);
  check("/tujuan lists the destinations", (await browser.waitFor(visibleRows)) === 4);
  await pickPartner(browser, 'input[name="customerFilter"]', "Contoh B");
  check("customer filter narrows the list", (await browser.waitFor(`${visibleRows} === 2 && ${visibleRows}`)) === 2 && (await browser.evaluate(rowText("Depo Contoh Lama"))).includes("Nonaktif"));
  await browser.click('button[aria-label="Kosongkan customer"]');
  await browser.waitFor(`${visibleRows} === 4`);
  await browser.click("Tujuan baru");
  await browser.click(inSheet('button[type="submit"]'));
  check("destination form asks for name and address", Boolean(await browser.hasText("Isi nama tempat.")) && Boolean(await browser.hasText("Isi alamat.")));
  await pickPartner(browser, inSheet('input[name="customerLookup"]'), "Contoh C");
  await browser.fill(inSheet('input[name="name"]'), "Gudang Uji Asap");
  await browser.fill(inSheet('textarea[name="address"]'), "Jalan Uji No. 1");
  await browser.fill(inSheet('input[name="regency"]'), "Kota Uji");
  await browser.click(inSheet('button[type="submit"]'));
  check("new destination is saved", Boolean(await browser.hasText("Tujuan Gudang Uji Asap ditambahkan.")));
  const newDestination = (await browser.waitFor(rowText("Gudang Uji Asap"))) ?? "";
  check("new destination is listed with its customer", ["Customer Contoh C", "Jalan Uji No. 1", "Kota Uji"].every((part) => newDestination.includes(part)), newDestination);
  await browser.screenshot("15-tujuan-light");

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
  check("/pengguna lists the accounts", (await browser.waitFor(visibleRows)) === 7);
  check("the page says what it is for", Boolean(await browser.hasText("belum punya hak akses")));
  await browser.type('input[type="search"]', "staf.baru", { perKey: true });
  await browser.waitFor(`${visibleRows} === 1 && ${rowText("Staf Baru Contoh")} !== ''`);
  check("an account without access is marked", (await browser.evaluate(rowText("Staf Baru Contoh"))).includes("Belum ada akses"));
  await browser.click('button[aria-label="Atur hak akses Staf Baru Contoh"]');
  const staffModules = await browser.waitFor(`[...document.querySelectorAll('[role="dialog"] select')].map((s) => s.name).join(' ')`);
  check(
    "a staff account is offered every module, each with its own levels",
    ["contracts", "drivers", "vehicles", "destinations", "delivery_orders", "registrations", "gate", "rfid_cards", "users"].every((code) =>
      (staffModules ?? "").includes(`permission-${code}`),
    ) &&
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
    partnerModules === "permission-contracts permission-drivers permission-vehicles permission-delivery_orders permission-registrations",
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

  await phaseThree(browser);
}

// --- phase 3: registration, delivery order, SPJ, the post ---------------------

const noHorizontalScroll = "document.documentElement.scrollWidth <= window.innerWidth";
const textOf = (selector) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').replace(/\\s+/g, ' ')`;

async function partnerSignIn(browser, username) {
  await browser.goto(`${WEB}/login`);
  await browser.type('input[name="username"]', username);
  await browser.type('input[name="password"]', "contoh-123");
  await browser.click('button[type="submit"]');
  await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Akun yang sedang masuk')");
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
  await browser.click("Simpan draf");
  const draftPath = await browser.waitFor("location.pathname.startsWith('/registrasi/r-') && location.pathname");
  check("a registration is saved as a draft", Boolean(draftPath) && Boolean(await browser.hasText("Registrasi disimpan sebagai draf.")));
  await browser.click("Ubah draf");
  check(
    "the draft opens in its form with the contract, the truck looked up again and the letter",
    Boolean(await browser.waitFor(`location.pathname.endsWith('/ubah') && document.querySelectorAll('[aria-label="Kontrak terpilih"] li').length === 1`)) &&
      Boolean(await browser.waitFor(`${textOf("main")}.includes('Surat kendaraan') && ${textOf("main")}.includes('Supir Contoh 02')`)) &&
      (await browser.evaluate(`document.querySelector('input[name="letters.0.originNetKg"]').value === '1000'`)),
  );
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
  await browser.waitFor(`Boolean(document.querySelector('select[name="destinationId"] option[value="t-1"]'))`);
  await browser.fill(inSheet('select[name="destinationId"]'), "t-1");
  await browser.fill(inSheet('input[name="qty"]'), "38002");
  await pickOption(browser, inSheet('input[name="transporterLookup"]'), "Contoh A");
  await browser.screenshot("22-do-form-light");
  await browser.click(inSheet('button[type="submit"]'));
  const created = (await browser.waitFor(`[...document.querySelectorAll('p')].find((p) => p.innerText.includes('dibuat sebagai draf'))?.innerText`)) ?? "";
  const doNo = /DO (\S+) dibuat/.exec(created)?.[1] ?? "";
  check("a delivery order made from a contract gets a generated number", /^\d{3}\/DO\/CTH\/[IVX]+\/\d{4}$/.test(doNo), doNo);
  check("the new delivery order is listed as draft with its customer", (await browser.evaluate(rowText(doNo))).includes("Customer Contoh A") && (await browser.evaluate(rowText(doNo))).includes("Draf"));
  await browser.click(`button[aria-label="Tindakan ${doNo}"]`);
  await browser.click("Kirim ke transporter");
  await browser.click(inSheet('button[type="submit"]'));
  check(
    "the delivery order is sent to the transporter",
    Boolean(await browser.hasText(`DO ${doNo} dikirim ke Transporter Contoh A.`)) && Boolean(await browser.waitFor(`${rowText(doNo)}.includes('Menunggu transporter')`)),
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
  const postsBefore = await stat("POST /api/registrations");
  await browser.click("Kirim registrasi");
  check(
    "close cargo and flexi bag are required when sending",
    Boolean(await browser.waitFor(`document.querySelectorAll('fieldset[aria-invalid="true"]').length === 2`)) &&
      (await stat("POST /api/registrations")) === postsBefore,
  );
  await browser.click('label:has(input[name="closeCargo"][value="yes"])');
  await browser.click('label:has(input[name="flexiBag"][value="no"])');
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
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...(DEV_MODE ? { NEXT_PUBLIC_API_URL: API } : {}) },
  });
  await waitForHttp(`${API}/api/health`, "mock API");
  await waitForHttp(`${WEB}/login`, "web app");

  browser = await Browser.launch(executable, { profileDir: path.join(outDir, "profile"), outDir, waitMs: WAIT_MS, spawnChild: start });
  await browser.openPage();
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
