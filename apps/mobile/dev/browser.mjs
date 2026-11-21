// Headless Edge or Chrome over the DevTools protocol, for dev/smoke.mjs and dev/shots.mjs. No dependencies.
// Adapted from apps/web/dev/browser.mjs; React Native Web renders testID as data-testid and roles as ARIA roles.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

export const findBrowser = () => BROWSERS.find((candidate) => existsSync(candidate)) ?? null;

export async function waitForHttp(url, label) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`${label} did not start at ${url}`);
}

/** Starts a child process and remembers it, so `stopAll` can end it. */
const children = [];
export function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
  children.push(child);
  return child;
}
export async function stopAll() {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
  await sleep(300);
  for (const child of children) {
    if (child.exitCode === null && process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    }
  }
  await sleep(300);
}

export class Browser {
  static async launch(executable, { profileDir, outDir, waitMs = 15000 }) {
    await mkdir(profileDir, { recursive: true });
    if (outDir) await mkdir(outDir, { recursive: true });
    const child = start(executable, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=390,844",
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
    this.consoleErrors = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") this.consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? "exception");
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
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(`page script failed: ${exceptionDetails.text} in ${expression.slice(0, 80)}`);
    return result.value;
  }

  async waitFor(expression, timeoutMs = this.waitMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
      } catch {
        // navigating
      }
      await sleep(100);
    }
    return null;
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'");
  }

  async hasText(text, timeoutMs) {
    const found = await this.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, timeoutMs);
    if (!found) throw new Error(`text not found: ${text}`);
  }

  /**
   * Clicks with real mouse events. `target` is a CSS selector, `testid:<id>`, or the visible label / aria-label of
   * a button, radio, tab or checkbox. `within` narrows the search to a container selector.
   */
  async click(target, { within, index = 0 } = {}) {
    const locate = `(() => {
      const wanted = ${JSON.stringify(target)};
      const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : "document"};
      if (!root) return null;
      let el = null;
      if (wanted.startsWith("testid:")) el = root.querySelector('[data-testid="' + wanted.slice(7) + '"]');
      else {
        try { el = root.querySelectorAll(wanted)[${index}] ?? null; } catch {}
        const visible = (node) => node.getClientRects().length > 0;
        el ??= [...root.querySelectorAll('[role="button"],[role="radio"],[role="tab"],[role="checkbox"],button')]
          .filter(visible)
          .find((node) => (node.getAttribute("aria-label") ?? "").trim() === wanted || node.innerText.trim() === wanted);
      }
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`;
    let point = await this.waitFor(locate);
    if (!point) throw new Error(`nothing to click for ${target}${within ? ` in ${within}` : ""}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(60);
      const next = (await this.evaluate(locate)) ?? point;
      const resting = Math.abs(next.x - point.x) < 0.5 && Math.abs(next.y - point.y) < 0.5;
      point = next;
      if (resting) break;
    }
    const mouse = { x: point.x, y: point.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { ...mouse, type: "mouseMoved", button: "none" });
    await this.send("Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" });
    await this.send("Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" });
    await sleep(80);
  }

  /** Sets an input or textarea the way React expects: the native setter, then an input event. */
  async fill(selector, value) {
    const css = selector.startsWith("testid:") ? `[data-testid="${selector.slice(7)}"]` : selector;
    const done = await this.waitFor(`(() => {
      const el = document.querySelector(${JSON.stringify(css)});
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!done) throw new Error(`no field ${selector}`);
    await sleep(40);
  }

  async scrollTo(selector) {
    const css = selector.startsWith("testid:") ? `[data-testid="${selector.slice(7)}"]` : selector;
    await this.waitFor(`(() => { const el = document.querySelector(${JSON.stringify(css)}); if (!el) return false; el.scrollIntoView({ block: "start" }); return true; })()`);
    await sleep(150);
  }

  async screenshot(name) {
    await sleep(500);
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(this.outDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  async viewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }

  async colorScheme(value) {
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  }

  async close() {
    await this.send("Browser.close", {}, undefined).catch(() => {});
  }
}
