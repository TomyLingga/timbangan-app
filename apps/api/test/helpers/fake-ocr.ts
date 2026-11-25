// A stand-in for the document reading service: POST /api/v1/surat-masuk/scan and /api/v1/surat-keluar/scan, each
// taking one multipart field `file` and answering what the test queued, in the shape the service documents.
// Every name, plate and number in the canned answers is made up.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

type Json = Record<string, unknown>;

const LETTER_DATA: Json = {
  nomor_spb: "0456/MS/UJI/XI/2026",
  tanggal_spb: "2026-11-19",
  unit_usaha: "PT. SAWIT SATU",
  nomor_kontrak: "0012/UJI/CPO-L/XI/2026",
  no_order_penyerahan: "OP-77/UJI",
  brutto_kg: 40120,
  tarra_kg: 12030,
  netto_kg: 28090,
  no_polisi: "BK 5001 EE",
  nama_supir: "SUPIR SURAT SATU",
  no_sim: "SIMSURAT0001",
  transporter: "PT. ANGKUT SATU",
  ffa: 3.58,
  kadar_air: 0.19,
  kadar_kotoran: 0.019,
  suhu: 50,
  ullage: null,
  keterangan: null,
};

const ORDER_DATA: Json = {
  nomor_do: "001/DO/UJI/XI/2026",
  tanggal: "2026-11-20",
  nomor_kontrak: "SC-401/CONTOH",
  nomor_po: "PO/2026/00077",
  pengangkut: "PT. ANGKUT SATU",
  tujuan: "GUDANG CONTOH",
  jenis_barang: "MINYAK CONTOH OLAHAN",
  kuantitas: 250000,
  satuan: "KG",
  tanggal_jadwal: "2026-11-22",
};

const LINE_KEYS = ["nomor_kontrak", "no_order_penyerahan", "brutto_kg", "tarra_kg", "netto_kg"];
const noFlags = (data: Json) => Object.fromEntries(Object.keys(data).map((key) => [key, false]));

/** An answer for a surat pengantar. `data` replaces values of the reading; `extra` replaces whole keys of the answer. */
export function letterAnswer(data: Json = {}, extra: Json = {}): Json {
  const read = { ...LETTER_DATA, ...data };
  const { brutto_kg: gross, tarra_kg: tare, netto_kg: net } = read as { brutto_kg: number | null; tarra_kg: number | null; netto_kg: number | null };
  const checked = gross === null || tare === null || net === null ? null : Math.abs(gross - tare - net) <= 1;
  return {
    status: "success",
    jenis_surat: "surat_masuk",
    template_terdeteksi: null,
    cara_deteksi: "yolo",
    data: read,
    baris: [Object.fromEntries(LINE_KEYS.map((key) => [key, read[key]]))],
    validasi: { netto_konsisten: checked, netto_konsisten_alasan: checked === null ? "ada angka berat yang gagal dibaca" : null },
    perlu_cek_manual: noFlags(read),
    perbaikan: {},
    alignment: null,
    peringatan: [],
    kandidat_template: null,
    yolo: { putaran: 0, field_ditemukan: 12, field_total: 12, keyakinan: { NOMOR_KONTRAK: 0.95 }, mutu: { field_ditemukan: 4, field_total: 6, keyakinan: {}, ragu_ragu: {} }, garis_dihapus: false, garis_catatan: null },
    debug_raw_ocr_text: { brutto_kg: "40.120" },
    ...extra,
  };
}

/** An answer for a delivery order. */
export function orderAnswer(data: Json = {}, extra: Json = {}): Json {
  const read = { ...ORDER_DATA, ...data };
  return {
    status: "success",
    jenis_surat: "surat_keluar",
    template_terdeteksi: null,
    cara_deteksi: "yolo",
    data: read,
    perlu_cek_manual: noFlags(read),
    perbaikan: {},
    alignment: null,
    peringatan: [],
    kandidat_template: null,
    yolo: { putaran: 0, field_ditemukan: 9, field_total: 9, keyakinan: { NOMOR_DO: 0.96 }, mutu: null, garis_dihapus: false, garis_catatan: null },
    debug_raw_ocr_text: { kuantitas: "250.000 Kg" },
    ...extra,
  };
}

/** What the service answers when it finds no field on the image. */
export const NO_FIELD_FOUND = { status: 422, body: { detail: { status: "error", reason: "YOLO tidak menemukan satu field pun di gambar ini", putaran_dicoba: [0, 90, 180, 270] } } };

export interface FakeOcrCall {
  method: string;
  path: string;
  contentType: string;
  /** The whole request body: the multipart envelope with the file inside. */
  body: Buffer;
}

export async function startFakeOcr() {
  const calls: FakeOcrCall[] = [];
  const queue: { status: number; body: unknown }[] = [];
  let gate: Promise<void> | null = null;

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const path = new URL(request.url ?? "", "http://fake.test").pathname;
    calls.push({ method: request.method ?? "", path, contentType: request.headers["content-type"] ?? "", body: Buffer.concat(chunks) });
    if (gate) await gate;
    if (response.destroyed) return;
    const known = request.method === "POST" && (path === "/api/v1/surat-masuk/scan" || path === "/api/v1/surat-keluar/scan");
    const answer = known ? (queue.shift() ?? { status: 200, body: path.includes("masuk") ? letterAnswer() : orderAnswer() }) : { status: 404, body: { detail: "Not Found" } };
    response.writeHead(answer.status, { "content-type": typeof answer.body === "string" ? "text/html" : "application/json" });
    response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  onTestFinished(async () => {
    if (server.listening) await close();
  });

  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    calls,
    /** The next scan request gets this answer; without one queued the service reads the default document. */
    answer(body: unknown, status = 200) {
      queue.push({ status, body });
    },
    /** Makes the service wait before it answers; call the returned function to let the answers go. */
    hold(): () => void {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    close,
  };
}
