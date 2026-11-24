// Screenshots of the GPS screens against dev/mock-api.mjs: Lacak kendaraan with a selected truck and its track,
// Pengaturan GPS, the key dialog, the driver's page and the SPJ with its second QR code. Same build as dev/smoke.mjs:
//
//   NEXT_PUBLIC_API_URL=http://localhost:3110 npm run build
//   node dev/gps-shots.mjs [output directory]
//
// The default output directory is ../../.data/ui-pilot (git-ignored); every file name starts with "gps-", except the
// destination pin screens ("do-pin-"; SHOTS=do-pin takes only those). Unlike
// the smoke test, the map loads the real OpenStreetMap tiles (MOCK_TILES=1 serves the mock's blank tiles instead).
// The mock's trucks drive in the open sea, so the tiles there are plain water.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, findBrowser, sleep, waitForHttp } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "..", "..", ".data", "ui-pilot"));
const profileDir = path.join(root, "dev", ".smoke", "gps-shots-profile");
const WEB_PORT = 3210;
const API_PORT = 3110;
const WEB = `http://localhost:${WEB_PORT}`;
const API = `http://localhost:${API_PORT}`;

const children = [];
function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  return child;
}

async function shoot(browser, name, { fullPage = false } = {}) {
  await sleep(1200);
  let clip;
  if (fullPage) {
    const { width, height } = await browser.evaluate("({ width: document.documentElement.clientWidth, height: Math.min(document.documentElement.scrollHeight, 6000) })");
    clip = { x: 0, y: 0, width, height, scale: 1 };
  }
  const { data } = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`saved ${name}.png`);
}

const tilesLoaded = "document.querySelectorAll('.leaflet-tile-loaded').length >= 4";

/** An access token of a mock account, for finding ids through the API. */
async function apiToken(username) {
  const started = await fetch(`${API}/api/auth/sso/start?as=${username}`, { redirect: "manual" });
  const ticket = new URL(started.headers.get("location") ?? "").searchParams;
  const exchange = await fetch(`${API}/api/auth/sso/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ticket.get("token"), appId: ticket.get("appId") }),
  });
  return (await exchange.json()).accessToken;
}

/** The destination pin of a DO: the form with the picker, the DO page, and Lacak kendaraan with the destination. */
async function doPinShots(browser) {
  const token = await apiToken("super.contoh");
  const orders = (await (await fetch(`${API}/api/delivery-orders`, { headers: { authorization: `Bearer ${token}` } })).json()).items;
  const pinned = orders.find((order) => order.destination?.location);
  const sheet = '[role="dialog"]';
  for (const theme of ["dark", "light"]) {
    await browser.colorScheme(theme);
    for (const [width, height, mobile] of [
      [1440, 900, false],
      [390, 844, true],
    ]) {
      await browser.viewport(width, height, mobile);
      await browser.goto(`${WEB}/delivery-order`);
      await browser.waitFor(`[...document.querySelectorAll('button')].some((button) => button.innerText.trim() === 'DO baru')`);
      await browser.click("DO baru");
      await browser.fill(`${sheet} input[name="destName"]`, "Gudang Contoh Tujuan");
      await browser.fill(`${sheet} input[name="destRegency"]`, "Kab. Contoh");
      await browser.evaluate(`(() => {
        const input = document.querySelector('${sheet} input[name="destLat"]');
        const data = new DataTransfer();
        data.setData('text/plain', '-10.68, 85.52');
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        document.querySelector('[data-testid="do-pin"]').scrollIntoView({ block: "start" });
      })()`);
      await browser.waitFor(`document.querySelector('[data-testid="do-pin"] .gps-destination') && ${tilesLoaded}`, 20000);
      await shoot(browser, `do-pin-form-${theme}-${width}`);
      await browser.pressEscape();

      await browser.goto(`${WEB}/delivery-order/${encodeURIComponent(String(pinned.id))}`);
      await browser.waitFor(`document.querySelector('[data-testid="do-pin-view"] .gps-destination') && ${tilesLoaded}`, 20000);
      await shoot(browser, `do-pin-detail-${theme}-${width}`, { fullPage: true });

      await browser.goto(`${WEB}/lacak?vehicle=v-2`);
      await browser.waitFor(`document.querySelector('[data-testid="gps-destination-row"]') && document.querySelector('.gps-map .gps-destination') && ${tilesLoaded}`, 20000);
      await shoot(browser, `do-pin-lacak-${theme}-${width}`, { fullPage: mobile });
    }
  }
}

async function run(browser) {
  await browser.goto(`${API}/api/auth/sso/start?as=super.contoh`);
  await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Akun yang sedang masuk')");
  // SHOTS=do-pin takes only the destination pin screens
  if (process.env.SHOTS === "do-pin") return doPinShots(browser);
  await doPinShots(browser);

  for (const theme of ["dark", "light"]) {
    await browser.colorScheme(theme);
    await browser.viewport(1440, 900);
    await browser.goto(`${WEB}/lacak?vehicle=v-3`);
    await browser.waitFor(`document.querySelector('[data-testid="gps-panel"]') && document.querySelector('path.gps-track') && ${tilesLoaded}`, 20000);
    await shoot(browser, `gps-lacak-${theme}-1440`);
    await browser.viewport(390, 844, true);
    await browser.goto(`${WEB}/lacak?vehicle=v-3`);
    await browser.waitFor(`document.querySelector('[data-testid="gps-panel"]') && ${tilesLoaded}`, 20000);
    await shoot(browser, `gps-lacak-${theme}-390`, { fullPage: true });
    await browser.viewport(1440, 900);
    await browser.goto(`${WEB}/lacak/pengaturan`);
    await browser.waitFor(`document.querySelector('[data-testid="gps-source"]') && document.querySelector('[data-testid="gps-settings-form"]') && ${tilesLoaded}`, 20000);
    await shoot(browser, `gps-pengaturan-${theme}-1440`, { fullPage: true });
  }

  // the key dialog, once
  await browser.colorScheme("dark");
  await browser.viewport(1440, 900);
  await browser.goto(`${WEB}/lacak/pengaturan`);
  await browser.waitFor(`document.querySelector('[data-testid="gps-source"]')`);
  await browser.click("Sumber baru");
  await browser.fill('[role="dialog"] input[name="sourceName"]', "Penyedia Contoh Dua");
  await browser.click('[role="dialog"] button[type="submit"]');
  await browser.waitFor(`document.querySelector('#gps-key-value')?.textContent`);
  await shoot(browser, "gps-kunci-dark-1440");
  await browser.click("Sudah saya simpan");

  // the SPJ with two QR codes
  await browser.colorScheme("light");
  await browser.goto(`${WEB}/spj/trip-1/cetak`);
  await browser.waitFor(`document.querySelectorAll('[data-testid="spj-sheet"] [data-barcode="qr"]').length === 2`);
  await shoot(browser, "gps-spj-dua-qr-light-1440", { fullPage: true });

  // the driver's page, signed out
  await browser.goto(`${WEB}/`);
  await browser.click('[data-testid="user-menu"]');
  await browser.click("Keluar");
  await browser.waitFor("location.pathname === '/login'");
  await browser.permission(WEB, "geolocation", "granted");
  await browser.geolocation({ lat: -10.52, lon: 85.2, accuracy: 9 });
  await browser.viewport(390, 844, true);
  for (const theme of ["dark", "light"]) {
    await browser.colorScheme(theme);
    await browser.goto(`${WEB}/bagi-lokasi/contoh-buka`);
    await browser.waitFor(`document.querySelector('[data-testid="share-ready"]')`);
    await shoot(browser, `gps-bagi-siap-${theme}-390`);
    await browser.click("Bagikan lokasi");
    await browser.waitFor(`document.querySelector('[data-testid="share-active"]') && !document.querySelector('[data-testid="share-last-sent"]').innerText.includes('belum')`);
    await shoot(browser, `gps-bagi-aktif-${theme}-390`, { fullPage: true });
    await browser.click("Berhenti");
    await browser.goto(`${WEB}/bagi-lokasi/contoh-tutup`);
    await browser.waitFor(`document.querySelector('[data-testid="share-closed"]')`);
    await shoot(browser, `gps-bagi-tutup-${theme}-390`);
  }
}

const executable = findBrowser();
if (!executable) {
  console.error("No Edge or Chrome found. Set SMOKE_BROWSER to the executable.");
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
let browser;
let failure = null;
try {
  start(process.execPath, ["dev/mock-api.mjs"], { env: { ...process.env, PORT: String(API_PORT), WEB_ORIGIN: WEB } });
  start(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(WEB_PORT)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  await waitForHttp(`${API}/api/health`, "mock API");
  await waitForHttp(`${WEB}/login`, "web app");
  browser = await Browser.launch(executable, { profileDir, outDir, waitMs: 10000, spawnChild: start });
  await browser.openPage();
  if (process.env.MOCK_TILES === "1") await browser.serveMapTilesFrom(`${API}/__mock/tile/`);
  await run(browser);
} catch (error) {
  failure = error;
} finally {
  if (browser) await browser.close();
  for (const child of children) child.kill();
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
