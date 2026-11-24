// Headless Edge or Chrome over the DevTools protocol, shared by dev/smoke.mjs
// and dev/e2e-real.mjs. No dependencies.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

/** The first Edge or Chrome found, or null. SMOKE_BROWSER names another executable. */
export function findBrowser() {
  return BROWSERS.find((candidate) => existsSync(candidate)) ?? null;
}

export async function waitForHttp(url, label) {
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

export class Browser {
  /**
   * `spawnChild(command, args)` starts the browser process and returns it, so
   * the caller can stop it with its other processes. Screenshots go to `outDir`.
   */
  static async launch(executable, { profileDir, outDir, waitMs, spawnChild }) {
    const child = spawnChild(executable, [
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
    return new Browser(socket, { outDir, waitMs });
  }

  constructor(socket, { outDir, waitMs }) {
    this.socket = socket;
    this.outDir = outDir;
    this.waitMs = waitMs;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = undefined;
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) void listener(message.params, message.sessionId);
        return;
      }
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
  async waitFor(expression, timeoutMs = this.waitMs) {
    const deadline = Date.now() + timeoutMs;
    // a DOM node cannot be returned by value; a found node counts as true
    const settled = `(() => { const value = (${expression}); return typeof Node !== "undefined" && value instanceof Node ? true : value; })()`;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(settled);
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
    const locate = `(() => {
      const wanted = ${JSON.stringify(selectorOrText)};
      let el = null;
      try { el = document.querySelector(wanted); } catch {}
      el ??= [...document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], [role="switch"]')]
        .find((node) => node.offsetParent !== null && node.innerText.trim() === wanted);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`;
    let point = await this.waitFor(locate);
    if (!point) throw new Error(`nothing to click for ${selectorOrText}`);
    // A sheet that is still sliding in moves its content; wait until the target rests.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(80);
      const next = (await this.evaluate(locate)) ?? point;
      const resting = Math.abs(next.x - point.x) < 0.5 && Math.abs(next.y - point.y) < 0.5;
      point = next;
      if (resting) break;
    }
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

  /** Sets a field the way React expects: the native setter, then the event React listens to. */
  async fill(selector, value) {
    const done = await this.waitFor(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      return true;
    })()`);
    if (!done) throw new Error(`no field ${selector}`);
  }

  async screenshot(name) {
    await sleep(450); // let entrance animations finish
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(this.outDir, `${name}.png`), Buffer.from(data, "base64"));
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

  /** Presses Enter in the focused element, the way a barcode or RFID reader ends its input. */
  async pressEnter() {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send("Input.dispatchKeyEvent", { ...key, type: "keyDown", text: "\r" });
    await this.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
  }

  async pressEscape() {
    const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await this.send("Input.dispatchKeyEvent", { ...key, type: "keyDown" });
    await this.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
  }

  /** Types into the focused element key by key, fast, like a reader does. */
  async typeFocused(text) {
    for (const piece of text) await this.send("Input.insertText", { text: piece });
  }

  async media(value) {
    await this.send("Emulation.setEmulatedMedia", { media: value });
  }

  /** Calls `listener(params, sessionId)` for every DevTools event `method`. */
  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  /**
   * Answers the page's requests for OpenStreetMap tiles with the mock's blank tile, so a map works without the
   * internet. Answers how many tiles it served so far, through the returned function.
   */
  async serveMapTilesFrom(tileBase) {
    let served = 0;
    this.on("Fetch.requestPaused", async (params, sessionId) => {
      const match = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(params.request.url);
      const answer = await fetch(`${tileBase}${match ? match.slice(1).join("-") : "0-0-0"}.png`);
      const body = Buffer.from(await answer.arrayBuffer()).toString("base64");
      served += 1;
      await this.send(
        "Fetch.fulfillRequest",
        { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "image/png" }], body },
        sessionId,
      ).catch(() => {});
    });
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "https://tile.openstreetmap.org/*" }] });
    return () => served;
  }

  /**
   * Puts this page in front and lets it believe it has the focus. A link with target=_blank opens a tab in front of
   * it, and a page in the background gets no location.
   */
  async bringToFront() {
    await this.send("Page.bringToFront");
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }

  /** Pretends the device stands at this place (null: no override). The page still needs the permission. */
  async geolocation(position) {
    if (position) await this.send("Emulation.setGeolocationOverride", { latitude: position.lat, longitude: position.lon, accuracy: position.accuracy ?? 10 });
    else await this.send("Emulation.clearGeolocationOverride");
  }

  /** Grants or denies a permission ("geolocation") to an origin, as the user would in the browser. */
  async permission(origin, name, setting) {
    // grantPermissions and resetPermissions are what Puppeteer uses; setPermission alone did not always grant
    if (setting === "granted") await this.send("Browser.grantPermissions", { origin, permissions: [name] }, undefined);
    else if (setting === "prompt") await this.send("Browser.resetPermissions", {}, undefined);
    else await this.send("Browser.setPermission", { origin, permission: { name }, setting }, undefined);
  }

  /** Runs `source` in every page before its own scripts, until removed with the answered id. */
  async addInitScript(source) {
    const { identifier } = await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
    return identifier;
  }

  async removeInitScript(identifier) {
    await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }

  async close() {
    await this.send("Browser.close", {}, undefined).catch(() => {});
  }
}
