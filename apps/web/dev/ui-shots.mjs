// Screenshots of the main screens against dev/mock-api.mjs, in both themes, at
// desktop (1440 px) and phone (390 px) width. Uses the same headless browser
// helper as dev/smoke.mjs and needs the same build:
//
//   NEXT_PUBLIC_API_URL=http://localhost:3110 npm run build
//   node dev/ui-shots.mjs [output directory]
//
// The default output directory is ../../.data/ui-pilot (git-ignored). Two
// passes: the mock with MOCK_FLOW=sample (trucks spread over the stages of the
// plant) for every page, then MOCK_FLOW=empty for Beranda without any truck.

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, findBrowser, sleep, waitForHttp } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "..", "..", ".data", "ui-pilot"));
const profileDir = path.join(root, "dev", ".smoke", "shots-profile");
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

/** Viewport on desktop, the whole page on a phone. */
async function shoot(browser, name, { fullPage = false } = {}) {
  await sleep(1500); // entrances, the flow drawing and count-ups finish
  let clip;
  if (fullPage) {
    const { width, height } = await browser.evaluate(
      "({ width: document.documentElement.clientWidth, height: Math.min(document.documentElement.scrollHeight, 6000) })",
    );
    clip = { x: 0, y: 0, width, height, scale: 1 };
  }
  const { data } = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`saved ${name}.png`);
}

const SIZES = [
  { width: 1440, height: 900, mobile: false, tag: "1440" },
  { width: 390, height: 844, mobile: true, tag: "390" },
];
const THEMES = ["dark", "light"];

/** Every theme and size of one page. `prepare` runs after each load. */
async function shootAll(browser, name, url, prepare) {
  for (const theme of THEMES) {
    await browser.colorScheme(theme);
    for (const size of SIZES) {
      await browser.viewport(size.width, size.height, size.mobile);
      await browser.goto(url);
      if (prepare) await prepare(size);
      // an open sheet sits over the viewport, so those phone shots keep to the viewport
      await shoot(browser, `${name}-${theme}-${size.tag}`, { fullPage: size.mobile && !name.endsWith("rincian") });
    }
  }
  await browser.viewport(1440, 900);
}

const listReady = (size) =>
  size.mobile ? "document.querySelectorAll('main ul > li').length > 0" : "document.querySelectorAll('tbody tr').length > 0";

/** Checks the first expected truck that the post lets through, so the card box is waiting. */
async function scanFirstClear(browser) {
  await browser.waitFor(`document.querySelectorAll('[data-testid="gate-upcoming"] button[aria-label^="Periksa "]').length > 0`);
  const count = await browser.evaluate(`document.querySelectorAll('[data-testid="gate-upcoming"] button[aria-label^="Periksa "]').length`);
  for (let index = 0; index < count; index += 1) {
    await browser.evaluate(`document.querySelectorAll('[data-testid="gate-upcoming"] button[aria-label^="Periksa "]')[${index}].click()`);
    if (await browser.waitFor("document.activeElement?.id === 'gate-card'", 2500)) break;
  }
  await browser.evaluate("window.scrollTo(0, 0)");
}

async function staff(browser) {
  // every module, so every page and the bell show
  await browser.goto(`${API}/api/auth/sso/start?as=super.contoh`);
  await browser.waitFor("location.pathname === '/' && document.body.innerText.includes('Akun yang sedang masuk')");
}

async function samplePass(browser) {
  await browser.viewport(1440, 900);
  await shootAll(browser, "login", `${WEB}/login`, () => browser.hasText("Masuk lewat Portal INL"));
  await staff(browser);

  await shootAll(browser, "beranda", `${WEB}/`, () => browser.waitFor(`document.querySelector('[aria-label="Truk per tahap"]')?.getAttribute('aria-busy') === 'false'`));
  await shootAll(browser, "kontrak", `${WEB}/kontrak`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "pos", `${WEB}/pos`, () => scanFirstClear(browser));
  await shootAll(browser, "keputusan", `${WEB}/keputusan`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "keputusan-rincian", `${WEB}/keputusan`, async (size) => {
    await browser.waitFor(listReady(size));
    await browser.evaluate(`[...document.querySelectorAll('button[aria-label^="Rincian Selisih bruto"]')].find((b) => b.offsetParent !== null).click(); true`);
    await browser.waitFor(`Boolean(document.querySelector('[data-testid="approval-decide"]'))`);
  });
  await shootAll(browser, "stasiun", `${WEB}/stasiun`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "laporan", `${WEB}/laporan`, async (size) => {
    await browser.waitFor(listReady(size));
  });
  await shootAll(browser, "laporan-truk", `${WEB}/laporan`, async (size) => {
    await browser.waitFor(listReady(size));
    await browser.click("Per truk");
    await browser.waitFor(`Boolean(document.querySelector('[data-testid="report-trips"]'))`);
  });
  await shootAll(browser, "pos-rincian", `${WEB}/pos`, async () => {
    await browser.waitFor(`Boolean(document.querySelector('button[aria-label^="Rincian "]'))`);
    await browser.click('button[aria-label^="Rincian ZZ 0004"]');
    await browser.waitFor(`Boolean(document.querySelector('[data-testid="trip-work"]'))`);
  });
  await shootAll(browser, "kendaraan", `${WEB}/kendaraan`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "registrasi", `${WEB}/registrasi`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "supir", `${WEB}/supir`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "tujuan", `${WEB}/tujuan`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "pengguna", `${WEB}/pengguna`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "kartu", `${WEB}/kartu`, (size) => browser.waitFor(listReady(size)));
  await shootAll(browser, "delivery-order", `${WEB}/delivery-order`, (size) => browser.waitFor(listReady(size)));
  await browser.goto(`${WEB}/registrasi`);
  await browser.waitFor(listReady({ mobile: false }));
  const detail = await browser.evaluate(`[...document.querySelectorAll('tbody tr')].find((row) => row.innerText.includes('0124/CONTOH') && row.innerText.includes('0125/CONTOH'))?.querySelector('a')?.getAttribute('href') ?? ''`);
  await shootAll(browser, "registrasi-rincian", `${WEB}${detail}`, async () => {
    await browser.click('button[aria-label="Langkah dan timbang truk 1"]');
    await browser.waitFor(`Boolean(document.querySelector('[data-testid="trip-work"] dl'))`);
  });

  // Extra states: a refused scan, the command palette, the phone drawer, the widened sidebar.
  await browser.colorScheme("dark");
  await browser.goto(`${WEB}/pos`);
  await browser.waitFor("document.activeElement?.id === 'gate-scan'");
  await browser.typeFocused("AAAAAAAAAAAA");
  await browser.pressEnter();
  await browser.hasText("Kode SPJ ini tidak dikenal.");
  await shoot(browser, "pos-refused-dark-1440");
  await browser.click("Kembalikan kartu");
  await browser.waitFor("document.activeElement?.id === 'gate-checkout'");
  await browser.typeFocused("04A1B2C305");
  await browser.pressEnter();
  await browser.waitFor(`Boolean(document.querySelector('[data-testid="gate-checkout-done"]'))`);
  await shoot(browser, "pos-kembali-dark-1440");
  await browser.goto(`${WEB}/stasiun`);
  await browser.waitFor(listReady({ mobile: false }));
  await browser.click('button[aria-label="Buat kunci mesin WB-2"]');
  await browser.waitFor(`Boolean(document.querySelector('[data-testid="station-key-dialog"]'))`);
  await browser.click("Buat kunci mesin");
  await browser.waitFor(`(document.querySelector('[data-testid="station-key"]')?.value ?? '').length > 20`);
  await shoot(browser, "stasiun-kunci-dark-1440");
  await browser.pressEscape();
  await browser.goto(`${WEB}/`);
  await browser.waitFor(`document.querySelector('[aria-label="Truk per tahap"]')?.getAttribute('aria-busy') === 'false'`);
  await browser.click('[data-testid="approvals-bell"]');
  await browser.waitFor(`Boolean(document.querySelector('[role="menu"]'))`);
  await shoot(browser, "lonceng-dark-1440");
  await browser.pressEscape();
  await browser.goto(`${WEB}/kontrak`);
  await browser.waitFor("document.querySelectorAll('tbody tr').length > 0");
  await browser.click('button[aria-label="Cari halaman"]');
  await browser.waitFor("document.querySelector('[role=\"listbox\"]')");
  await shoot(browser, "palette-dark-1440");
  await browser.pressEscape();
  await browser.waitFor("!document.querySelector('[role=\"dialog\"]')");
  await sleep(300);
  await browser.click('button[aria-label="Lebarkan menu"]');
  await browser.waitFor("document.documentElement.dataset.sidebar === 'full'");
  await shoot(browser, "sidebar-full-dark-1440");
  await browser.click('button[aria-label="Ciutkan menu"]');
  await browser.viewport(390, 844, true);
  await browser.goto(`${WEB}/kontrak`);
  await browser.click('button[aria-label="Buka menu"]');
  await browser.waitFor("document.querySelector('[role=\"dialog\"] nav')");
  await shoot(browser, "drawer-dark-390");
}

async function emptyPass(browser) {
  await staff(browser);
  await shootAll(browser, "beranda-empty", `${WEB}/`, () => browser.hasText("Belum ada truk di jalur hari ini."));
}

async function withServers(flow, work) {
  const before = children.length;
  start(process.execPath, ["dev/mock-api.mjs"], { env: { ...process.env, PORT: String(API_PORT), WEB_ORIGIN: WEB, MOCK_SYNC_MS: "400", MOCK_FLOW: flow } });
  start(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(WEB_PORT)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  await waitForHttp(`${API}/api/health`, "mock API");
  await waitForHttp(`${WEB}/login`, "web app");
  const browser = await Browser.launch(findBrowser(), { profileDir, outDir, waitMs: 8000, spawnChild: start });
  try {
    await browser.openPage();
    await work(browser);
  } catch (error) {
    await shoot(browser, `failure-${flow}`).catch(() => {});
    throw error;
  } finally {
    await browser.close();
    for (const child of children.splice(before)) child.kill();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(500);
      if (await rm(profileDir, { recursive: true, force: true }).then(() => true, () => false)) break;
    }
  }
}

if (!findBrowser()) {
  console.error("No Edge or Chrome found. Set SMOKE_BROWSER to the executable.");
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
let failure = null;
try {
  await withServers("sample", samplePass);
  await withServers("empty", emptyPass);
} catch (error) {
  failure = error;
} finally {
  for (const child of children) child.kill();
}
if (failure) {
  console.error(`Stopped: ${failure.message}`);
  process.exit(1);
}
