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
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const children = [];
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  return child;
}

async function waitForHttp(url, label) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`${label} did not start at ${url}`);
}

function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// --- DevTools protocol ------------------------------------------------------

class Browser {
  static async launch(executable, profileDir) {
    const child = start(executable, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1366,900",
      "about:blank",
    ]);
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the browser gave no DevTools address")), 20000);
      child.stderr.on("data", (chunk) => {
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk));
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Browser(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = undefined;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async openPage() {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, undefined);
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true }, undefined);
    this.sessionId = sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page script failed: ${exceptionDetails.text} in ${expression.slice(0, 80)}`);
    return result.value;
  }

  /** Polls until the expression is truthy. Returns its value, or null on timeout. */
  async waitFor(expression, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
      } catch {
        // The page is navigating; try again.
      }
      await sleep(100);
    }
    return null;
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'");
  }

  hasText(text) {
    return this.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`);
  }

  /** Clicks with real mouse events, by CSS selector or by the visible label. */
  async click(selectorOrText) {
    const point = await this.waitFor(`(() => {
      const wanted = ${JSON.stringify(selectorOrText)};
      let el = null;
      try { el = document.querySelector(wanted); } catch {}
      el ??= [...document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], [role="switch"]')]
        .find((node) => node.offsetParent !== null && node.innerText.trim() === wanted);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    if (!point) throw new Error(`nothing to click for ${selectorOrText}`);
    const mouse = { x: point.x, y: point.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { ...mouse, type: "mouseMoved", button: "none" });
    await this.send("Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" });
    await this.send("Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" });
  }

  async type(selector, text, { perKey = false } = {}) {
    const focused = await this.waitFor(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    })()`);
    if (!focused) throw new Error(`no field ${selector}`);
    for (const piece of perKey ? [...text] : [text]) {
      await this.send("Input.insertText", { text: piece });
      if (perKey) await sleep(40);
    }
  }

  async screenshot(name) {
    await sleep(450); // let entrance animations finish
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  }

  async viewport(width, height, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  }

  async colorScheme(value) {
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  }

  async historyUrls() {
    const { entries } = await this.send("Page.getNavigationHistory");
    return entries.map((entry) => entry.url);
  }

  async close() {
    await this.send("Browser.close", {}, undefined).catch(() => {});
  }
}

// --- checks -----------------------------------------------------------------

const visibleRows = `[...document.querySelectorAll('tbody tr')].filter((row) => row.offsetParent !== null).length`;
const stat = async (route) => (await (await fetch(`${API}/__mock/stats`)).json()).requests[route] ?? 0;
const location = (browser) => browser.evaluate("location.pathname + location.search");

async function signOut(browser) {
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
  check("header shows name, company and role label", Boolean(await browser.waitFor(`(() => {
    const text = document.querySelector('[data-testid="header-identity"]')?.innerText ?? '';
    return text.includes('Admin PKS Contoh A') && text.includes('PKS Contoh A') && text.includes('PKS / supplier');
  })()`)));
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
  check("date reads as 31 Des 2026 and tolerance as 0,3%", tableText.includes("31 Des 2026") && tableText.includes("0,3%"));
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
  check("drawer lists the later modules without links", Boolean(await browser.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const links = [...dialog.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    return dialog.innerText.includes('Delivery Order') && dialog.innerText.includes('Denah') && links.length === 2;
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

  // 14. Staff account without a role.
  await browser.goto(`${API}/api/auth/sso/start?as=staf.baru`);
  check("staff without a role sees the waiting page with the name", Boolean(await browser.hasText("Akun belum punya peran")) && Boolean(await browser.hasText("Staf Baru Contoh")));
  await browser.screenshot("10-no-role");
  await browser.click("Keluar");
  check("sign-out works from the no-role page", Boolean(await browser.waitFor("location.pathname === '/login'")));
}

// --- main -------------------------------------------------------------------

const executable = BROWSERS.find((candidate) => existsSync(candidate));
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

  browser = await Browser.launch(executable, path.join(outDir, "profile"));
  await browser.openPage();
  await run(browser);
} catch (error) {
  failure = error;
  if (browser) await browser.screenshot("failure").catch(() => {});
} finally {
  if (browser) await browser.close();
  for (const child of children) child.kill();
  await sleep(500);
  await rm(path.join(outDir, "profile"), { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((result) => !result.passed).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
if (failure) console.error(`Stopped early: ${failure.message}`);
process.exit(failure || failed > 0 ? 1 : 0);
