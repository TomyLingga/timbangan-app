// Client of the document reading service: a separate service on the plant network that finds the fields of a
// scanned surat pengantar (incoming) or delivery order (outgoing) and reads them. It gets the image and nothing
// else; it never reaches this database. What it answers holds names and licence numbers, so neither the answer
// nor the image is ever logged or put in an error message: only sizes, counts and timings are.
import type { OcrConfig } from "../config.js";

export type Direction = "IN" | "OUT";
export type OcrValue = string | number | null;

export interface OcrField {
  /** The field name the service uses, for example "nomor_kontrak". */
  key: string;
  value: OcrValue;
  /** The service asks for a look at this value before it is used. */
  needsCheck: boolean;
  /** Why the value was corrected or flagged; null when the service gave no reason. */
  reason: string | null;
}

export interface OcrReading {
  /** The service answered a reading with at least one field. */
  read: boolean;
  /** No reading, or fewer than half of the fields found: usually a layout the service has not been trained on. */
  unreadable: boolean;
  fields: OcrField[];
  /**
   * Incoming only: one row per contract on the letter, usually one. Each row holds the fields that repeat
   * (contract, order penyerahan, gross, tare, net); the first row is the same as those fields in `fields`.
   */
  lines: Record<string, OcrField>[];
  /** Messages about the whole document. */
  warnings: string[];
  fieldsFound: number | null;
  fieldsTotal: number | null;
  /** Incoming only, as the service judged it: true, false, or null when it could not check (or said nothing). */
  netConsistent: boolean | null;
  netConsistentReason: string | null;
  ms: number;
}

export class OcrError extends Error {
  override name = "OcrError";
  constructor(
    readonly kind: "UNREACHABLE" | "TIMEOUT" | "FAILED",
    readonly ms: number,
    /** The HTTP status of a FAILED answer. */
    readonly status?: number,
  ) {
    super(kind === "FAILED" ? `the document reading service answered HTTP ${status}` : kind === "TIMEOUT" ? "the document reading service did not answer in time" : "the document reading service could not be reached");
  }
}

const PATHS: Record<Direction, string> = { IN: "/api/v1/surat-masuk/scan", OUT: "/api/v1/surat-keluar/scan" };
/** The service answers these when the image is not a document it can read; anything else above 299 is a fault. */
const NOT_A_DOCUMENT = new Set([400, 422]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const valueOf = (value: unknown): OcrValue => (typeof value === "string" ? value.trim() || null : typeof value === "number" && Number.isFinite(value) ? value : null);
const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const countOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

function nothingRead(ms: number, warning: string): OcrReading {
  return { read: false, unreadable: true, fields: [], lines: [], warnings: [warning], fieldsFound: null, fieldsTotal: null, netConsistent: null, netConsistentReason: null, ms };
}

/** The reading inside an answer of the service, whatever is missing from it. */
export function readingOf(answer: unknown, ms: number): OcrReading {
  const body = recordOf(answer);
  const data = recordOf(body.data);
  if (body.status !== "success" || Object.keys(data).length === 0) return nothingRead(ms, "Layanan baca dokumen tidak mengembalikan hasil.");
  const flags = recordOf(body.perlu_cek_manual);
  const reasons = recordOf(body.perbaikan);
  const field = (key: string, value: unknown, flagKey = key, flagDefault = false): OcrField => ({
    key,
    value: valueOf(value),
    needsCheck: typeof flags[flagKey] === "boolean" ? flags[flagKey] : flagDefault,
    reason: textOf(reasons[flagKey]),
  });
  const detector = recordOf(body.yolo);
  const fieldsFound = countOf(detector.field_ditemukan);
  const fieldsTotal = countOf(detector.field_total);
  const lines = (Array.isArray(body.baris) ? body.baris : []).filter(isRecord).map((row, index) =>
    // the service flags the fields of a further row as "<field>_baris<n>", and always asks for a look at them
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, index === 0 ? field(key, value) : field(key, value, `${key}_baris${index + 1}`, true)])),
  );
  const check = recordOf(body.validasi);
  return {
    read: true,
    unreadable: fieldsFound !== null && fieldsTotal !== null && fieldsTotal > 0 && fieldsFound * 2 < fieldsTotal,
    fields: Object.entries(data).map(([key, value]) => field(key, value)),
    lines,
    warnings: (Array.isArray(body.peringatan) ? body.peringatan : []).map(textOf).filter((text) => text !== null),
    fieldsFound,
    fieldsTotal,
    netConsistent: typeof check.netto_konsisten === "boolean" ? check.netto_konsisten : null,
    netConsistentReason: textOf(check.netto_konsisten_alasan),
    ms,
  };
}

/**
 * Sends the image to the service and answers its reading. A document the service cannot read (it found no
 * field, or the image would not open) is a reading with `read` false; a service that is down, slow or broken
 * throws OcrError.
 */
export async function readDocument(config: OcrConfig, direction: Direction, image: { bytes: Buffer; mimeType: string }): Promise<OcrReading> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const form = new FormData();
  // a neutral name: the name the scanner or the operator gave the file stays here
  form.append("file", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.mimeType === "image/png" ? "scan.png" : "scan.jpg");
  let status: number;
  let text: string;
  try {
    const response = await fetch(`${config.url}${PATHS[direction]}`, { method: "POST", body: form, headers: { accept: "application/json" }, signal: AbortSignal.timeout(config.timeoutMs) });
    status = response.status;
    text = await response.text();
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    throw new OcrError(name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "UNREACHABLE", elapsed());
  }
  if (NOT_A_DOCUMENT.has(status)) return nothingRead(elapsed(), "Layanan baca dokumen tidak menemukan isi surat pada gambar ini.");
  if (status < 200 || status > 299) throw new OcrError("FAILED", elapsed(), status);
  let answer: unknown = null;
  try {
    answer = JSON.parse(text);
  } catch {
    // not JSON: handled below as an answer without a reading
  }
  return readingOf(answer, elapsed());
}
