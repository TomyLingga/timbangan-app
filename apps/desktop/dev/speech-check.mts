// Speech check: proves that the speech of the API plays inside the Electron window. Builds dev/speech-check
// (its own main process and page around the program's real API client, preload, audio module and speech queue),
// starts it against a running API and judges what the page recorded.
//
//   npm run speech:check                      muted (Chromium --mute-audio), API at http://localhost:3100
//   npm run speech:check -- --audible         through the speakers
//   npm run speech:check -- --api http://server-name:3100
//   npm run speech:check -- --autoplay-policy document-user-activation-required   Chromium's own default, to compare
//
// The station key comes from SPEECH_CHECK_STATION_KEY. Without it the check signs in with DEV_ADMIN_USERNAME and
// DEV_ADMIN_PASSWORD from the API's .env (--api-env, default ../api/.env), keeps one inactive station WB-CEK-SUARA
// for itself, gives it a new key, turns it on for the run and off again, and signs out. It only asks for speech
// and for one unknown card: nothing is weighed, registered or changed beyond that station.
// Exit code 0 only when every segment with audio was decoded and ended, the tone played for the one without, and
// the segments finished in order, in every round.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import type { CheckOutput, Mark } from "./speech-check/marks.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    api: { type: "string" },
    audible: { type: "boolean", default: false },
    "api-env": { type: "string" },
    "autoplay-policy": { type: "string" },
    rounds: { type: "string", default: "2" },
  },
});
const apiBaseUrl = (args.api ?? process.env.SPEECH_CHECK_API ?? "http://localhost:3100").replace(/\/+$/, "");
const workDir = join(tmpdir(), "timbangan-speech-check");
const STATION_CODE = "WB-CEK-SUARA";

// ---- station key -----------------------------------------------------------------------------------------------

interface Admin {
  key: string;
  done(): Promise<void>;
}

async function adminStation(): Promise<Admin> {
  const envPath = resolve(appDir, args["api-env"] ?? "../api/.env");
  if (!existsSync(envPath)) throw new Error(`no SPEECH_CHECK_STATION_KEY and no ${envPath}`);
  const env = parseEnv(readFileSync(envPath, "utf8"));
  if (!env.DEV_ADMIN_PASSWORD) throw new Error(`DEV_ADMIN_PASSWORD is not in ${envPath}`);
  let token = "";
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(apiBaseUrl + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${json?.error?.code ?? ""}`);
    return { json: json ?? {}, response };
  };
  const login = await call("POST", "/api/auth/login", { username: env.DEV_ADMIN_USERNAME ?? "admin", password: env.DEV_ADMIN_PASSWORD });
  token = String(login.json.accessToken ?? "");
  cookie = (login.response.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
  const signOut = () => call("POST", "/api/auth/logout", {}).then(() => undefined, () => undefined);
  try {
    const stations = (await call("GET", "/api/stations")).json.items as { id: number; code: string; isActive: boolean }[];
    let station = stations.find((item) => item.code === STATION_CODE);
    if (!station) {
      station = (
        await call("POST", "/api/stations", {
          code: STATION_CODE,
          name: "Cek suara (alat pengembang, jangan dipakai)",
          kind: "WEIGHBRIDGE",
          config: { directions: ["IN", "OUT"], cameraWeigh1: 1, cameraWeigh2: 2, plateAttempts: 1 },
          isActive: false,
        })
      ).json.station;
      console.log(`station ${STATION_CODE} created (inactive between runs)`);
    }
    const id = station!.id;
    const key = String((await call("POST", `/api/stations/${id}/key`, {})).json.key ?? "");
    await call("PATCH", `/api/stations/${id}`, { isActive: true });
    return {
      key,
      done: async () => {
        await call("PATCH", `/api/stations/${id}`, { isActive: false }).catch((error: Error) => console.log(`could not turn ${STATION_CODE} off: ${error.message}`));
        await signOut();
      },
    };
  } catch (error) {
    await signOut();
    throw error;
  }
}

// ---- build and run -----------------------------------------------------------------------------------------------

async function buildCheck(): Promise<void> {
  process.env.SPEECH_CHECK_OUT = join(workDir, "out");
  const { build } = await import("electron-vite");
  await build({ root: appDir, configFile: join(appDir, "dev/speech-check/electron.vite.config.ts"), logLevel: "warn" });
}

function runElectron(key: string): Promise<{ code: number | null; output: CheckOutput | null; stderr: string }> {
  const electron = createRequire(import.meta.url)("electron") as string;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPEECH_CHECK_API: apiBaseUrl,
    SPEECH_CHECK_STATION_KEY: key,
    SPEECH_CHECK_AUDIBLE: args.audible ? "1" : "0",
    SPEECH_CHECK_ROUNDS: args.rounds,
    SPEECH_CHECK_USER_DATA: join(workDir, "user-data"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (args["autoplay-policy"]) env.SPEECH_CHECK_AUTOPLAY_POLICY = args["autoplay-policy"];
  else delete env.SPEECH_CHECK_AUTOPLAY_POLICY;
  return new Promise((done) => {
    const child = spawn(electron, [join(workDir, "out/main/index.js")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    // the main process ends itself; this only catches a hang, and takes the whole process tree down
    const limit = setTimeout(() => {
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }, 5 * 60_000);
    child.on("close", (code) => {
      clearTimeout(limit);
      const line = stdout.split(/\r?\n/).find((text) => text.startsWith("SPEECH_CHECK_RESULT "));
      done({ code, output: line ? (JSON.parse(line.slice("SPEECH_CHECK_RESULT ".length)) as CheckOutput) : null, stderr });
    });
  });
}

// ---- judge and print ---------------------------------------------------------------------------------------------

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);
const ms = (value: number | undefined) => (value === undefined ? "-" : `${Math.round(value)} ms`);

function judge(output: CheckOutput): boolean {
  const page = output.page;
  if (!page) return false;
  let pass = true;
  const fail = (text: string) => {
    pass = false;
    console.log(`  FAIL ${text}`);
  };
  const contexts = page.marks.filter((mark) => mark.kind === "context");
  console.log(`autoplay policy of the window: ${output.autoplayPolicy}; user activation in the window: ${page.hasBeenActive}`);
  console.log(`AudioContext state at creation: ${contexts.map((mark) => mark.value).join(", ") || "(none created)"}; at the end: ${page.contextStates.join(", ") || "-"}`);
  const changes = page.marks.filter((mark) => mark.kind === "state").map((mark) => `${mark.value} at ${ms(mark.at)}`);
  if (changes.length) console.log(`AudioContext state changes: ${changes.join(", ")}`);
  for (const [round, segments] of output.rounds.entries()) {
    const marks = page.marks.filter((mark) => mark.round === round);
    console.log(`\nround ${round + 1}${round === 0 ? " (plate and weights new to the API)" : " (from the API cache)"}`);
    const finished: number[] = [];
    for (const [index, text] of segments.entries()) {
      const of = (kind: Mark["kind"]) => marks.filter((mark) => mark.segment === index && mark.kind === kind);
      const fetched = output.fetches.find((record) => record.round === round && record.text === text);
      const speaking = of("speaking")[0]?.at;
      const decoded = of("decoded")[0]?.value;
      const start = of("start")[0]?.at;
      const ended = of("ended")[0]?.at;
      const toneEnd = of("tone-end").at(-1)?.at;
      const end = ended ?? toneEnd;
      if (end !== undefined) finished.push(index);
      console.log(`  ${index + 1}. ${short(text)}`);
      const fetchText = fetched ? `fetch ${ms(fetched.ms)}, HTTP ${fetched.status ?? "none"}, ${fetched.bytes === null ? "no audio" : `${fetched.bytes} bytes`}` : "fetch not seen";
      if (fetched?.bytes) {
        const seconds = typeof decoded === "number" ? decoded : undefined;
        console.log(`     ${fetchText}; decoded ${seconds === undefined ? String(decoded ?? "no") : `${seconds.toFixed(2)} s`}; shown to start ${ms(start !== undefined && speaking !== undefined ? start - speaking : undefined)}; start to onended ${ms(ended !== undefined && start !== undefined ? ended - start : undefined)}`);
        if (seconds === undefined) fail(`segment ${index + 1} was not decoded`);
        else if (ended === undefined || start === undefined) fail(`segment ${index + 1} never ended`);
        else if (ended - start < seconds * 1000 * 0.9) fail(`segment ${index + 1} ended after ${Math.round(ended - start)} ms, shorter than its ${seconds.toFixed(2)} s`);
      } else {
        const toneStart = of("tone-start")[0]?.at;
        console.log(`     ${fetchText}; tone ${toneStart === undefined ? "not played" : `played, ${ms(toneEnd !== undefined ? toneEnd - toneStart : undefined)} until its end`}`);
        if (toneStart === undefined || toneEnd === undefined) fail(`segment ${index + 1} has no audio and no tone was played`);
      }
    }
    console.log(`  finished in order: ${finished.map((index) => index + 1).join(", ") || "-"}`);
    const first = marks.find((mark) => mark.kind === "speaking")?.at;
    const idle = marks.find((mark) => mark.kind === "idle")?.at;
    console.log(`  queue ${idle === undefined ? "never got idle" : `idle ${ms(first !== undefined ? idle - first : undefined)} after the first segment was shown`}`);
    if (finished.join(",") !== segments.map((_text, index) => index).join(",")) fail("segments did not all finish, or not in order");
    if (marks.some((mark) => mark.kind === "timeout")) fail("the queue did not get idle in time");
  }
  return pass;
}

// ---- main --------------------------------------------------------------------------------------------------------

let admin: Admin | null = null;
let passed = false;
try {
  const health = await fetch(`${apiBaseUrl}/api/health`).then((response) => response.json() as Promise<{ status?: string }>, () => null);
  if (health?.status !== "ok") throw new Error(`the API at ${apiBaseUrl} does not answer /api/health`);
  await buildCheck();
  let key = process.env.SPEECH_CHECK_STATION_KEY ?? "";
  if (!key) {
    admin = await adminStation();
    key = admin.key;
  }
  console.log(`speech check against ${apiBaseUrl}, ${args.audible ? "audible" : "muted"}`);
  const run = await runElectron(key);
  if (!run.output) {
    console.log(`no result from Electron (exit code ${run.code})`);
    console.log(run.stderr.trim().split(/\r?\n/).slice(-20).join("\n"));
  } else {
    if (run.output.error) console.log(`error: ${run.output.error}`);
    passed = judge(run.output) && run.code === 0 && !run.output.error;
    const notes = new Map<string, number>();
    for (const line of run.output.console.filter((text) => /audio|autoplay|gesture/i.test(text))) notes.set(line, (notes.get(line) ?? 0) + 1);
    if (notes.size) console.log(`\nwindow console:\n  ${[...notes].map(([line, count]) => (count > 1 ? `${count}x ${line}` : line)).join("\n  ")}`);
  }
} catch (error) {
  console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await admin?.done();
}
console.log(`\nspeech check ${passed ? "passed" : "FAILED"}`);
process.exit(passed ? 0 : 1);
