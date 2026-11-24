// Screenshots of the web build against the mock API at 390x844, in the dark and the light theme.
//
//   EXPO_PUBLIC_API_URL=http://127.0.0.1:3210 npx expo export --platform web
//   node dev/shots.mjs [output folder]      default: ../../.data/mobile-pilot (outside the repository's git files)

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, findBrowser, sleep, start, stopAll, waitForHttp } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT ?? 3210);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(process.argv[2] ?? path.join(here, "..", "..", "..", ".data", "mobile-pilot"));
const taken = [];

const network = (online) => fetch(`${ORIGIN}/__mock/network`, { method: "POST", body: JSON.stringify({ online }) });
const radio = (field, label) => `[data-testid="field-${field}"] [role="radio"][aria-label="${label}"]`;
// a tank row is labelled "<code>, <what it holds>[, produk lain]"
const tank = (field, code) => `[data-testid="field-${field}"] [role="radio"][aria-label^="${code},"]`;

async function shot(browser, scheme, name) {
  const file = await browser.screenshot(`${scheme}-${name}`);
  taken.push(path.basename(file));
}

async function openStep(browser, id, testid) {
  await browser.goto(`${ORIGIN}/langkah/${id}`);
  const ok = await browser.waitFor(`!!document.querySelector('[data-testid="${testid}"]') && !!document.querySelector('[data-testid="truck-block"]')`);
  if (!ok) throw new Error(`form ${testid} did not open for step ${id}`);
  await sleep(300);
}

async function checkAndShow(browser, field) {
  await browser.click("testid:form-check");
  await browser.waitFor(`document.body.innerText.includes("isian yang perlu diperbaiki")`);
  await browser.scrollTo(`testid:field-${field}`);
}

async function run(browser, scheme) {
  await fetch(`${ORIGIN}/__mock/reset`, { method: "POST" });
  await browser.colorScheme(scheme);
  await browser.goto(`${ORIGIN}/`);
  await browser.evaluate("localStorage.clear(); sessionStorage.clear(); true");

  await browser.goto(`${ORIGIN}/masuk`);
  await browser.hasText("Timbangan Lapangan");
  await shot(browser, scheme, "01-masuk");

  await browser.fill("testid:login-username", "operator");
  await browser.fill("testid:login-password", "contoh123");
  await browser.click("testid:login-submit");
  await browser.waitFor(`!!document.querySelector('[data-testid="work-row-1"]')`);
  await shot(browser, scheme, "02-beranda");

  await browser.click("Cari");
  await browser.fill("testid:find-plate", "ZZ 0004 CTH");
  await browser.click("testid:find-submit");
  await browser.hasText("Langkah yang siap untuk Anda");
  await shot(browser, scheme, "03-cari");

  // seal check: the result left open
  await openStep(browser, 1, "form-seal-check");
  await browser.click('[data-testid="field-seals"] [role="radio"][aria-label="Utuh"]', { index: 0 });
  await browser.click('[data-testid="field-seals"] [role="radio"][aria-label="Rusak"]', { index: 1 });
  await checkAndShow(browser, "result");
  await shot(browser, scheme, "04-form-cek-segel");

  // QC pass: MOIST left empty, then the summary
  await openStep(browser, 2, "form-qc-receiving");
  await browser.fill("testid:input-value.FFA", "5,60");
  await browser.click(radio("disposition", "HOLD"));
  await browser.click(radio("reasonCode", "FFA Out Spec"));
  await checkAndShow(browser, "value.FFA");
  await shot(browser, scheme, "05-form-qc-pass");
  await browser.fill("testid:input-value.MOISTURE", "0,21");
  await browser.fill("testid:input-remark", "Sampel kedua dikirim ke lab");
  await browser.click("testid:form-check");
  await browser.waitFor(`!!document.querySelector('[data-testid="summary-sheet"]')`);
  await shot(browser, scheme, "06-ringkasan-qc-pass");

  // reseal: no seal chosen; then the seal picker
  await openStep(browser, 5, "form-reseal");
  await checkAndShow(browser, "seals");
  await shot(browser, scheme, "07-form-segel-kembali");
  await browser.click("Pilih No Segel 1");
  await browser.waitFor(`!!document.querySelector('[data-testid="seal-picker"]') && document.body.innerText.includes("L-000101")`);
  await shot(browser, scheme, "08-pilih-segel");

  // unloading: tank-empty tick left open
  await openStep(browser, 4, "form-unloading");
  await browser.click(tank("tankId", "T-02"));
  await browser.click(radio("doorNo", "3"));
  for (const [field, label] of [["wood", "Tidak Ada"], ["wire", "Tidak Ada"], ["plastic", "Ada"], ["handbrake", "On"], ["engine", "Off"], ["manhole", "Terbuka"], ["valve", "Aktif"]]) {
    await browser.click(radio(field, label));
  }
  await checkAndShow(browser, "tankEmpty");
  await shot(browser, scheme, "09-form-bongkar");

  // cleanliness (bulk): Nozzle Odor left open
  await openStep(browser, 6, "form-cleanliness");
  for (const field of ["containerClean", "noLiquid", "noForeignObject", "noPestOrNajis", "wallsCleanDryNoLeak", "noOdor", "flashLight", "nozzleVisual", "disposition"]) {
    await browser.click(radio(field, "OK"));
  }
  await browser.click(radio("nozzleNo", "Nozzle 2"));
  await checkAndShow(browser, "nozzleOdor");
  await shot(browser, scheme, "10-form-cek-kebersihan");

  // QC loading: the blend tank equals the main tank
  await openStep(browser, 7, "form-qc-loading");
  await browser.fill("testid:input-value.FFA", "0,05");
  await browser.fill("testid:input-value.MOISTURE", "0,05");
  await browser.click(tank("tankId", "T-03"));
  await browser.click(radio("blend", "Ya"));
  await browser.click(tank("blendTankId", "T-03"));
  await checkAndShow(browser, "blendTankId");
  await shot(browser, scheme, "11-form-qc-loading");

  // loading: start (no fields), then stop with a temperature out of range
  await openStep(browser, 8, "form-loading-start");
  await shot(browser, scheme, "12-form-muat-mulai");
  await openStep(browser, 9, "form-loading-finish");
  await browser.fill("testid:input-temperature", "135");
  await browser.click(radio("quality", "OK"));
  await browser.click(radio("handbrake", "On"));
  await browser.click(radio("engine", "Off"));
  await checkAndShow(browser, "temperature");
  await shot(browser, scheme, "13-form-muat-stop");

  // sealing after a reload: old seal not marked opened
  await openStep(browser, 10, "form-sealing");
  await browser.click("Pilih No Segel 1");
  await browser.waitFor(`document.body.innerText.includes("L-000101")`);
  await browser.click("Segel L-000101");
  await checkAndShow(browser, "oldSeals");
  await shot(browser, scheme, "14-form-segel");

  // a form sent without network: waiting in the queue
  await openStep(browser, 11, "form-cleanliness");
  for (const field of ["containerClean", "noLiquid", "noForeignObject", "noPestOrNajis", "wallsCleanDryNoLeak", "noOdor", "disposition"]) {
    await browser.click(radio(field, "OK"));
  }
  await browser.click("testid:form-check");
  await browser.waitFor(`!!document.querySelector('[data-testid="summary-sheet"]')`);
  await network(false);
  await browser.click("testid:summary-send");
  await browser.waitFor(`!!document.querySelector('[data-testid="screen-beranda"]') && document.body.innerText.includes("Menunggu terkirim")`);
  await browser.waitFor(`document.body.innerText.includes("Tidak tersambung")`, 20000);
  await shot(browser, scheme, "15-beranda-tanpa-sinyal");
  await browser.click("Profil");
  await browser.waitFor(`!!document.querySelector('[data-testid="queue-item-waiting"]')`);
  await browser.scrollTo("testid:queue-panel");
  await shot(browser, scheme, "16-antrean-menunggu");
  await network(true);
  await browser.click("testid:queue-retry");
  await browser.waitFor(`!!document.querySelector('[data-testid="queue-item-sent"]')`, 20000);

  // decisions
  await browser.click("Keputusan");
  await browser.waitFor(`!!document.querySelector('[data-testid="request-901"]')`);
  await shot(browser, scheme, "17-keputusan");
  await browser.click("testid:request-901");
  await browser.waitFor(`!!document.querySelector('[data-testid="decision-figures"]')`);
  await shot(browser, scheme, "18-keputusan-rincian");
  await browser.click("testid:decide-APPROVE");
  await browser.hasText("Alasan wajib diisi, minimal 3 huruf.");
  await browser.scrollTo("testid:decision-reason");
  await shot(browser, scheme, "19-keputusan-alasan");
  await browser.goto(`${ORIGIN}/keputusan/903`);
  await browser.waitFor(`!!document.querySelector('[data-testid="decide-ADD_LOAD"]')`);
  await browser.scrollTo("testid:decision-figures");
  await shot(browser, scheme, "20-keputusan-netto-keluar");
  await browser.goto(`${ORIGIN}/keputusan/905`);
  await browser.waitFor(`!!document.querySelector('[data-testid="decision-figures"]')`);
  await shot(browser, scheme, "21-keputusan-qc");

  await browser.goto(`${ORIGIN}/profil`);
  await browser.waitFor(`!!document.querySelector('[data-testid="screen-profil"]')`);
  await shot(browser, scheme, "22-profil");
}

async function main() {
  const executable = findBrowser();
  if (!executable) throw new Error("no Edge or Chrome found");
  start(process.execPath, [path.join(here, "mock-api.mjs")], { env: { ...process.env, MOCK_PORT: String(PORT) } });
  await waitForHttp(`${ORIGIN}/__mock/state`, "mock API");
  const browser = await Browser.launch(executable, { profileDir: path.join(here, ".profile", "shots"), outDir: OUT, waitMs: 15000 });
  try {
    await browser.openPage();
    await browser.viewport(390, 844);
    for (const scheme of ["dark", "light"]) await run(browser, scheme);
    if (browser.consoleErrors.length) console.error(`page errors: ${browser.consoleErrors.join(" | ")}`);
  } finally {
    await browser.close();
  }
}

main()
  .then(async () => {
    await stopAll();
    console.log(`${taken.length} screenshots in ${OUT}`);
    for (const name of taken) console.log(`  ${name}`);
    process.exit(0);
  })
  .catch(async (error) => {
    await stopAll();
    console.error(`shots failed after ${taken.length}: ${error.message}`);
    process.exit(1);
  });
