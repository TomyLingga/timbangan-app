// Walks the web build against the mock API: sign in, open the QC pass form, fill it, send it while the network
// is cut, see it wait in the queue, bring the network back, see it sent, and check the mock stored it once.
//
//   EXPO_PUBLIC_API_URL=http://127.0.0.1:3210 npx expo export --platform web
//   node dev/smoke.mjs

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, findBrowser, sleep, start, stopAll, waitForHttp } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT ?? 3210);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const steps = [];
const pass = (label) => {
  steps.push(label);
  console.log(`ok ${steps.length} - ${label}`);
};

async function setNetwork(online) {
  await fetch(`${ORIGIN}/__mock/network`, { method: "POST", body: JSON.stringify({ online }) });
}

async function main() {
  if (!existsSync(path.join(here, "..", "dist", "index.html"))) throw new Error("no web build: run the export first");
  const executable = findBrowser();
  if (!executable) throw new Error("no Edge or Chrome found");
  start(process.execPath, [path.join(here, "mock-api.mjs")], { env: { ...process.env, MOCK_PORT: String(PORT) } });
  await waitForHttp(`${ORIGIN}/__mock/state`, "mock API");
  await fetch(`${ORIGIN}/__mock/reset`, { method: "POST" });

  const browser = await Browser.launch(executable, { profileDir: path.join(here, ".profile", "smoke"), outDir: path.join(here, "out") });
  try {
    await browser.openPage();
    await browser.viewport(390, 844);
    await browser.goto(`${ORIGIN}/`);
    await browser.evaluate("localStorage.clear(); sessionStorage.clear(); true");
    await browser.goto(`${ORIGIN}/masuk`);
    await browser.hasText("Timbangan Lapangan");
    pass("Masuk is shown");

    await browser.fill("testid:login-username", "operator");
    await browser.fill("testid:login-password", "contoh123");
    await browser.click("testid:login-submit");
    await browser.hasText("Daftar kerja");
    await browser.waitFor(`!!document.querySelector('[data-testid="work-row-2"]')`);
    pass("signed in, work list loaded");

    await browser.click("testid:work-row-2");
    await browser.waitFor(`!!document.querySelector('[data-testid="form-qc-receiving"]')`);
    await browser.hasText("QC pass CPO");
    pass("QC pass form opened");

    await browser.click("testid:form-check");
    await browser.hasText("FFA wajib diisi.");
    pass("empty form shows field errors");

    await browser.fill("testid:input-value.FFA", "3,25");
    await browser.fill("testid:input-value.MOISTURE", "0,15");
    await browser.click("OK", { within: '[data-testid="field-disposition"]' });
    await browser.click("testid:form-check");
    await browser.waitFor(`!!document.querySelector('[data-testid="summary-sheet"]')`);
    await browser.hasText("Ringkasan QC pass CPO");
    pass("summary sheet shown");

    await setNetwork(false);
    await browser.click("testid:summary-send");
    await browser.waitFor(`!!document.querySelector('[data-testid="screen-beranda"]')`);
    await browser.hasText("Menunggu terkirim");
    pass("network cut: the work row is marked waiting to be sent");

    await browser.click("Profil");
    await browser.waitFor(`!!document.querySelector('[data-testid="queue-item-waiting"]')`);
    pass("Profil lists the submission as waiting");

    await setNetwork(true);
    await browser.click("testid:queue-retry");
    const sent = await browser.waitFor(`!!document.querySelector('[data-testid="queue-item-sent"]')`, 20000);
    if (!sent) throw new Error("the submission was not sent after the network came back");
    pass("network back: the submission is sent");

    const state = await (await fetch(`${ORIGIN}/__mock/state`)).json();
    const stored = state.submissions.filter((item) => item.form === "qc-receiving" && item.stepId === 2);
    if (stored.length !== 1) throw new Error(`expected one stored submission, got ${stored.length}`);
    const body = stored[0].body;
    if (body.values.FFA !== 3.25 || body.values.MOISTURE !== 0.15 || body.disposition !== "OK") throw new Error(`unexpected body ${JSON.stringify(body)}`);
    pass(`the mock stored it once (${stored[0].posts} post${stored[0].posts === 1 ? "" : "s"} for uuid ${stored[0].clientUuid})`);

    await browser.click("Beranda");
    await sleep(800);
    const gone = await browser.waitFor(`!document.querySelector('[data-testid="work-row-2"]')`);
    if (!gone) throw new Error("the done step is still on the work list");
    pass("the step left the work list");

    if (browser.consoleErrors.length) throw new Error(`page errors: ${browser.consoleErrors.join(" | ")}`);
    pass("no page errors");
  } finally {
    await browser.close();
  }
}

main()
  .then(async () => {
    await stopAll();
    console.log(`smoke: ${steps.length} of ${steps.length} passed`);
    process.exit(0);
  })
  .catch(async (error) => {
    await stopAll();
    console.error(`smoke failed after ${steps.length} steps: ${error.message}`);
    process.exit(1);
  });
