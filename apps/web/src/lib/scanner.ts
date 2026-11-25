// The scanner helper of the registration post: a small program on the post's own PC that drives the scanner
// through Windows and answers over HTTP on the loopback address. The protocol is the one of the helper the old
// application installed, so that helper keeps working:
//
//   GET /status[?device=<id>]        JSON { ok, version, scanners: [{ id, name }], selected: { id, name, feeder,
//                                    feeder_ready } | null, message? }; ok is false when no scanner was found
//   GET /scan?dpi=<n>[&device=<id>]  one page from the feeder as image/jpeg; JSON { ok: false, message } with 404
//                                    (scanner not found), 409 (no paper in the feeder) or 500 (the scan failed)
//
// Requests are plain GETs without credentials or own headers, so the browser sends no preflight and the helper's
// `Access-Control-Allow-Origin: *` is enough. Without `device` the helper takes its default scanner.

import { SCANNER_URL } from "@/lib/config";

export const SCAN_DPI = 200;
const STATUS_TIMEOUT_MS = 3_000;
/** A page at a high resolution through a slow driver takes a while. */
const SCAN_TIMEOUT_MS = 180_000;

export interface ScannerDevice {
  id: string;
  name: string;
}

export type ScannerStatus =
  /** The helper answers and has a scanner to use. */
  | { state: "ready"; device: ScannerDevice; devices: ScannerDevice[]; feederReady: boolean | null; version: string | null }
  /** The helper answers, but it found no scanner (or not the one asked for). */
  | { state: "no-scanner"; devices: ScannerDevice[]; version: string | null }
  /** Nothing answers at the helper's address. */
  | { state: "offline" };

export type ScannerFailure = "OFFLINE" | "NO_SCANNER" | "NO_PAPER" | "FAILED";

export class ScannerError extends Error {
  readonly kind: ScannerFailure;
  constructor(kind: ScannerFailure) {
    super(`scanner helper: ${kind}`);
    this.name = "ScannerError";
    this.kind = kind;
  }
}

const withDevice = (device: string | null) => (device ? `&device=${encodeURIComponent(device)}` : "");

/** `stamp` keeps a proxy or the browser from answering an old status. */
export function statusUrl(base: string, device: string | null, stamp: number): string {
  return `${base}/status?t=${stamp}${withDevice(device)}`;
}

export function scanUrl(base: string, device: string | null, dpi: number): string {
  return `${base}/scan?dpi=${dpi}${withDevice(device)}`;
}

function devicesOf(value: unknown): ScannerDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, name } = entry as { id?: unknown; name?: unknown };
    return typeof id === "string" && id ? [{ id, name: typeof name === "string" && name ? name : id }] : [];
  });
}

/** The answer of GET /status as this app uses it; anything that is not such an answer counts as no scanner. */
export function readStatus(body: unknown): ScannerStatus {
  const answer = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const devices = devicesOf(answer.scanners);
  const version = typeof answer.version === "string" ? answer.version : null;
  const [selected] = devicesOf([answer.selected]);
  if (answer.ok !== true || !selected) return { state: "no-scanner", devices, version };
  const ready = (answer.selected as { feeder_ready?: unknown }).feeder_ready;
  return { state: "ready", device: selected, devices, feederReady: typeof ready === "boolean" ? ready : null, version };
}

/** Why GET /scan did not answer a page, from its HTTP status. */
export function scanFailureOf(status: number): ScannerFailure {
  if (status === 404) return "NO_SCANNER";
  if (status === 409) return "NO_PAPER";
  return "FAILED";
}

/** The scanner the operator chose earlier when it is still there; else null, and the helper takes its default. */
export function rememberedDevice(devices: readonly ScannerDevice[], remembered: string | null): string | null {
  return remembered !== null && devices.some((device) => device.id === remembered) ? remembered : null;
}

const MESSAGES: Record<ScannerFailure, string> = {
  OFFLINE: "Pembantu scanner di PC ini tidak menjawab. Jalankan scanner-helper di PC pos, atau pilih berkas scan.",
  NO_SCANNER: "Scanner tidak ditemukan di PC ini. Periksa kabel dan daya scanner, atau pilih berkas scan.",
  NO_PAPER: "Tidak ada kertas di scanner. Masukkan dokumen, lalu pindai lagi.",
  FAILED: "Scanner gagal memindai. Coba lagi, atau pilih berkas scan.",
};

export function scannerMessage(kind: ScannerFailure): string {
  return MESSAGES[kind];
}

export interface ScannerOptions {
  base?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

async function get(url: string, timeoutMs: number, doFetch: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no credentials and no headers of our own: the helper answers any origin, but only a simple request
    return await doFetch(url, { signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

/** Asks the helper whether it runs and which scanner it would use. Never throws. */
export async function scannerStatus(device: string | null, options: ScannerOptions = {}): Promise<ScannerStatus> {
  const { base = SCANNER_URL, fetch: doFetch = globalThis.fetch, now = Date.now } = options;
  try {
    const response = await get(statusUrl(base, device, now()), STATUS_TIMEOUT_MS, doFetch);
    return readStatus(await response.json());
  } catch {
    return { state: "offline" };
  }
}

/** Has the helper scan one page and answers it as a JPEG file. Throws ScannerError. */
export async function scanPage(device: string | null, options: ScannerOptions & { dpi?: number } = {}): Promise<File> {
  const { base = SCANNER_URL, fetch: doFetch = globalThis.fetch, now = Date.now, dpi = SCAN_DPI } = options;
  let response: Response;
  try {
    response = await get(scanUrl(base, device, dpi), SCAN_TIMEOUT_MS, doFetch);
  } catch {
    throw new ScannerError("OFFLINE");
  }
  if (!response.ok) throw new ScannerError(scanFailureOf(response.status));
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new ScannerError("FAILED");
  }
  if (blob.size === 0) throw new ScannerError("FAILED");
  return new File([blob], `scan-${now()}.jpg`, { type: "image/jpeg" });
}
