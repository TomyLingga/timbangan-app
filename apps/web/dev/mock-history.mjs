// Mock of the archive of the old weighbridge application (apps/api src/history/routes.ts): GET /api/history/trips
// and GET /api/history/trips/:id, staff with module reports. dev/mock-api.mjs passes its own guard and answer
// helpers to `historyRoutes()`. Every plate, name, ticket, contract and BA number here is made up; "ZZ" is not a
// region code, so no plate belongs to a real vehicle.
//
// The rows cover each state, a multi-contract truck (two rows of one group), QC, unloading and loading sheets,
// seals, decisions with a BA number, and values the import could not read (kept as their original text).
// MOCK_HISTORY=off makes both routes answer 503, for the error state of the page.

const DAY_MS = 86_400_000;
/** YYYY-MM-DD of the plant (UTC+7) some days before today. */
const daysAgo = (days) => new Date(Date.now() + 7 * 3_600_000 - days * DAY_MS).toISOString().slice(0, 10);
/** An ISO time on that day, at a plant hour. */
const at = (day, hour, minute = 0) => new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+07:00`).toISOString();

const PARTNERS_IN = ["PT Sawit Rekaan", "PKS Contoh Utara", "PT Kebun Karangan"];
const CUSTOMERS = ["PT Minyak Rekaan", "CV Olein Contoh"];
const TRANSPORTERS = ["PT Angkut Rekaan", "CV Truk Contoh"];
const DRIVERS = ["Supir Rekaan Satu", "Supir Rekaan Dua", "Supir Rekaan Tiga", "Supir Rekaan Empat", "Supir Rekaan Lima"];

function baseRow(index) {
  const id = index + 1;
  const legacyId = 90_000 + id;
  // two rows a day over the last 32 days, so the default 30 days hold more than one page
  const entryDate = daysAgo(Math.floor(index / 2));
  const incoming = index % 3 !== 2;
  const gross = 38_000 + ((index * 137) % 4_000);
  const tare = 14_000 + ((index * 53) % 2_000);
  const net = gross - tare;
  return {
    id,
    site: index % 7 === 5 ? "SBY" : "SMK",
    legacyId,
    ticketNo: String(70_000 + id),
    direction: incoming ? "IN" : "OUT",
    material: incoming ? "CPO" : "OUT_BULK",
    state: "COMPLETED",
    entryDate,
    arrivedAt: at(entryDate, 7, 10),
    leftAt: at(entryDate, 11, 40),
    plateText: `ZZ ${9000 + (index % 40)} RK`,
    plateNo: `ZZ${9000 + (index % 40)}RK`,
    driverName: DRIVERS[index % DRIVERS.length],
    licenceNo: `SIMREKAAN${String(index % DRIVERS.length).padStart(2, "0")}`,
    transporter: TRANSPORTERS[index % TRANSPORTERS.length],
    partnerName: incoming ? PARTNERS_IN[index % PARTNERS_IN.length] : CUSTOMERS[index % CUSTOMERS.length],
    mill: incoming ? "PKS Rekaan" : null,
    productName: incoming ? "CPO" : "RBD Palm Olein",
    uom: "Kg",
    reference: incoming ? `${String(100 + (index % 9)).padStart(4, "0")}/KONTRAK/REK/XI/2026` : `${String(200 + (index % 5)).padStart(3, "0")}/DO-REK/REK/XI/2026`,
    doNo: incoming ? "-" : `${String(200 + (index % 5)).padStart(3, "0")}/DO-REK/REK/XI/2026`,
    poNo: incoming ? null : `PO-REK-${300 + (index % 5)}`,
    spbNo: incoming ? `SPB-REK-${id}` : null,
    handoverNo: null,
    docGrossKg: incoming ? gross - 20 : null,
    docTareKg: incoming ? tare + 10 : null,
    docNetKg: incoming ? net - 30 : null,
    grossKg: gross,
    tareKg: tare,
    netKg: net,
    weigh1At: at(entryDate, 7, 40),
    weigh2At: at(entryDate, 10, 55),
    weigh1By: "petugas.rekaan1",
    weigh2By: "petugas.rekaan2",
    groupId: null,
    closeCargo: incoming ? null : index % 2 === 0,
    flexiBag: incoming ? null : false,
    details: {
      flags: { jenis: incoming ? "1" : "2", type: "OUT", finish: "1" },
      registration: { no_contract: incoming ? `KTR-REK-${index % 9}` : null, rfid: `04REKAAN${String(id).padStart(4, "0")}` },
      weighing: { type: "OUT", netto_diff: "0" },
      ...(incoming
        ? {
            qc: { ffa: "3.20", mni: "0.25", disposisi: "Diterima", qcpass_usr: "qc.rekaan", qcpass_tgl: `${entryDate} 08:05:00`, approve: "1" },
            unloading: { no_pintu: String(1 + (index % 4)), trf_name: "Tangki Timbun 2", unloading_usr: "bongkar.rekaan", unloading_tgl: `${entryDate} 09:30:00`, cek_bau: "1" },
          }
        : {
            loading: {
              nama_tangki: "T-REK-1",
              no_surat_coa: `COA-REK-${id}`,
              no_surat_jalan: `FJS NO.${id}/INL-LOG/XI/2026`,
              temp: "45",
              time_start: `${entryDate} 08:10:00`,
              time_stop: `${entryDate} 09:05:00`,
              loading_usr: "muat.rekaan",
              segel1: `LC-REK-${String(id * 2).padStart(4, "0")}`,
              segel2: `LC-REK-${String(id * 2 + 1).padStart(4, "0")}`,
              segel_usr: "segel.rekaan",
              cek_kendaraan_bersih: "1",
            },
            seals: [`LC-REK-${String(id * 2).padStart(4, "0")}`, `LC-REK-${String(id * 2 + 1).padStart(4, "0")}`],
          }),
    },
  };
}

function buildRows() {
  const rows = Array.from({ length: 64 }, (_, index) => baseRow(index));
  // a truck with two contracts: one group, one gross and tare, the net split between the rows
  const [first, second] = rows;
  Object.assign(first, { groupId: first.legacyId, netKg: 14_000, docNetKg: 14_000, reference: "0101/KONTRAK/REK/XI/2026" });
  Object.assign(second, {
    groupId: first.legacyId,
    plateText: first.plateText,
    plateNo: first.plateNo,
    driverName: first.driverName,
    entryDate: first.entryDate,
    grossKg: first.grossKg,
    tareKg: first.tareKg,
    netKg: first.grossKg - first.tareKg - 14_000,
    direction: "IN",
    material: "CPO",
    reference: "0102/KONTRAK/REK/XI/2026",
    doNo: "-",
  });
  first.details.splits = [{ id: 1, bruto: String(first.grossKg), tarra: String(first.tareKg), netto: "14000" }];
  // an outgoing tank truck refused at the cleanliness check, before loading
  Object.assign(rows[2], { state: "REJECTED_CLEANLINESS", weigh2At: null, grossKg: null, netKg: null });
  rows[2].details.loading = { cek_kendaraan_bersih: "0", cek_genangan_cairan: "1", cek_keterangan: "Sisa cairan di dasar tangki", cek_usr: "qc.rekaan" };
  delete rows[2].details.seals;
  // an incoming truck refused by QC, with the request it raised
  Object.assign(rows[3], { state: "REJECTED_QC", weigh2At: null, tareKg: null, netKg: null });
  rows[3].details.qc = { ffa: "6.80", mni: "0.90", disposisi: "Ditolak", qcpass_usr: "qc.rekaan", remark: "FFA di atas batas kontrak", no_surat_out_spec: "OS-REK-004" };
  delete rows[3].details.unloading;
  Object.assign(rows[4], { state: "UNFINISHED", leftAt: null, weigh2At: null, tareKg: null, netKg: null, site: "UNKNOWN" });
  // values the import could not read: kept as their original text, the column is null
  Object.assign(rows[6], { docGrossKg: null, weigh2At: null, arrivedAt: null });
  rows[6].details.original = { "registrasi.bruto_from": "40.010 kg", "timbangan.tgl_timbang2": "2026-11-31 25:61", "registrasi.tgl_masuk_truk": "kemarin pagi" };
  // a few older rows, outside the default 30 days
  for (const row of rows.slice(60)) {
    row.entryDate = daysAgo(45 + row.id);
  }
  return rows;
}

const ROWS = buildRows();

/** Requests for a decision, with the BA they led to; keyed by the legacy id of the truck. */
const EXCEPTIONS = [
  {
    id: 1, site: "SMK", source: "APPROVAL", legacyId: 501, legacyRegId: ROWS[0].legacyId, type: "NETTO_IN", status: "APPROVED", decision: "Terima dengan BA",
    ticketNo: ROWS[0].ticketNo, plateText: ROWS[0].plateText, driverName: ROWS[0].driverName, transporter: ROWS[0].transporter, reference: ROWS[0].reference,
    docGrossKg: ROWS[0].docGrossKg, weighedGrossKg: ROWS[0].grossKg, weighedTareKg: ROWS[0].tareKg, weighedNetKg: ROWS[0].grossKg - ROWS[0].tareKg,
    diffKg: 310, diffPct: 0.82, tolerancePct: 0.5, requestedAt: at(ROWS[0].entryDate, 11, 0), respondedAt: at(ROWS[0].entryDate, 11, 20),
    respondedBy: "manajer.rekaan", reportNo: "BA-REK/2026/0051", reportAt: at(ROWS[0].entryDate, 11, 25), reportBy: "admin.rekaan", details: {},
  },
  {
    id: 2, site: "SMK", source: "APPROVAL", legacyId: 502, legacyRegId: ROWS[3].legacyId, type: "BRUTO_IN", status: "REJECTED", decision: "Tolak",
    ticketNo: ROWS[3].ticketNo, plateText: ROWS[3].plateText, driverName: ROWS[3].driverName, transporter: ROWS[3].transporter, reference: ROWS[3].reference,
    docGrossKg: ROWS[3].docGrossKg, weighedGrossKg: ROWS[3].grossKg, weighedTareKg: null, weighedNetKg: null,
    diffKg: null, diffPct: null, tolerancePct: 0.5, requestedAt: at(ROWS[3].entryDate, 8, 0), respondedAt: at(ROWS[3].entryDate, 8, 30),
    respondedBy: "manajer.rekaan", reportNo: null, reportAt: null, reportBy: null,
    // the difference was typed as text in the old row
    details: { original: { "selisih_approval.selisih": "+-300", "selisih_approval.selisih_persen": "0,8 %" } },
  },
  {
    id: 3, site: "SMK", source: "REPORT", legacyId: 503, legacyRegId: ROWS[5].legacyId, type: null, status: null, decision: null,
    ticketNo: ROWS[5].ticketNo, plateText: ROWS[5].plateText, driverName: ROWS[5].driverName, transporter: ROWS[5].transporter, reference: ROWS[5].reference,
    docGrossKg: null, weighedGrossKg: ROWS[5].grossKg, weighedTareKg: null, weighedNetKg: null, diffKg: 120, diffPct: 0.3, tolerancePct: null,
    requestedAt: null, respondedAt: null, respondedBy: null, reportNo: "BA-REK/2026/0060", reportAt: at(ROWS[5].entryDate, 12, 0), reportBy: "admin.rekaan", details: {},
  },
];

const LIST_KEYS = [
  "id", "site", "legacyId", "ticketNo", "direction", "material", "state", "entryDate", "arrivedAt", "leftAt", "plateText", "plateNo", "driverName", "licenceNo",
  "transporter", "partnerName", "mill", "productName", "uom", "reference", "doNo", "poNo", "spbNo", "handoverNo", "docGrossKg", "docTareKg", "docNetKg",
  "grossKg", "tareKg", "netKg", "weigh1At", "weigh2At", "weigh1By", "weigh2By", "groupId", "closeCargo", "flexiBag",
];
const listed = (row) => Object.fromEntries(LIST_KEYS.map((key) => [key, row[key] ?? null]));

const CSV_HEADER = [
  "Cabang", "Id lama", "Nomor tiket", "Arah", "Keadaan", "Tanggal entry", "Masuk", "Keluar", "Plat", "Supir", "SIM", "Transporter", "Partner", "Asal PKS", "Produk",
  "Satuan", "Kontrak atau DO", "Nomor DO", "PO", "SPB", "Nomor penyerahan", "Bruto surat", "Tarra surat", "Netto surat", "Bruto", "Tarra", "Netto", "Timbang 1",
  "Timbang 2", "Kelompok", "Close cargo", "Flexi bag",
];
const CSV_KEYS = [
  "site", "legacyId", "ticketNo", "direction", "state", "entryDate", "arrivedAt", "leftAt", "plateText", "driverName", "licenceNo", "transporter", "partnerName", "mill",
  "productName", "uom", "reference", "doNo", "poNo", "spbNo", "handoverNo", "docGrossKg", "docTareKg", "docNetKg", "grossKg", "tareKg", "netKg", "weigh1At",
  "weigh2At", "groupId", "closeCargo", "flexiBag",
];
const yesNo = (value) => (value === true ? "ya" : value === false ? "tidak" : null);

const DIRECTIONS = ["IN", "OUT", "UNKNOWN"];
const STATES = ["COMPLETED", "REJECTED_QC", "REJECTED_CLEANLINESS", "UNFINISHED"];
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const contains = (value, q) => String(value ?? "").toLowerCase().includes(q.toLowerCase());

/** The routes, behind the caller's guard (staff only, reports VIEW) and with its answer helpers. */
export function historyRoutes({ guard, send, fail, invalid, sendCsv, reportPage }) {
  const off = () => process.env.MOCK_HISTORY === "off";
  const readers = (request, response) => guard(request, response, [["reports", "VIEW"]], { staffOnly: true });

  return {
    "GET /api/history/trips": (request, response, url) => {
      if (!readers(request, response)) return 0;
      if (off()) return fail(request, response, 503, "UNAVAILABLE", "Arsip tidak tersedia (mock).");
      const params = url.searchParams;
      const q = (params.get("q") ?? "").trim();
      const from = params.get("from") ?? "";
      const to = params.get("to") ?? "";
      const direction = params.get("direction") ?? "";
      const state = params.get("state") ?? "";
      const site = (params.get("site") ?? "").trim().toUpperCase();
      if ((from && !isDate(from)) || (to && !isDate(to))) return invalid(request, response, { from: "Tanggal harus berbentuk YYYY-MM-DD." });
      if (from && to && from > to) return invalid(request, response, { to: "Tanggal akhir tidak boleh sebelum tanggal awal." });
      if (direction && !DIRECTIONS.includes(direction)) return invalid(request, response, { direction: "Arah harus IN, OUT, atau UNKNOWN." });
      if (state && !STATES.includes(state)) return invalid(request, response, { state: "Keadaan tidak dikenal." });
      const page = reportPage(url);
      if (!page) return invalid(request, response, { limit: "Limit harus angka mulai dari 1." });

      const plate = q.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const matches = ROWS.filter(
        (row) =>
          (!q || row.ticketNo === q || contains(row.reference, q) || contains(row.doNo, q) || contains(row.driverName, q) || (plate && String(row.plateNo ?? "").includes(plate))) &&
          (!from || (row.entryDate && row.entryDate >= from)) &&
          (!to || (row.entryDate && row.entryDate <= to)) &&
          (!direction || row.direction === direction) &&
          (!state || row.state === state) &&
          (!site || row.site === site),
      ).sort((a, b) => (a.entryDate === b.entryDate ? b.legacyId - a.legacyId : a.entryDate < b.entryDate ? 1 : -1));

      if (params.get("format") === "csv") {
        return sendCsv(request, response, "riwayat-lama.csv", CSV_HEADER, matches.map((row) => CSV_KEYS.map((key) => (key === "closeCargo" || key === "flexiBag" ? yesNo(row[key]) : row[key]))));
      }
      const trucks = new Set(matches.map((row) => row.groupId ?? row.legacyId));
      const completed = matches.filter((row) => row.state === "COMPLETED");
      return send(request, response, 200, {
        items: matches.slice(page.offset, page.offset + page.limit).map(listed),
        total: matches.length,
        limit: page.limit,
        offset: page.offset,
        totals: {
          trucks: trucks.size,
          completedTrucks: new Set(completed.map((row) => row.groupId ?? row.legacyId)).size,
          netKg: completed.reduce((sum, row) => sum + (row.netKg ?? 0), 0),
        },
      });
    },

    "GET /api/history/trips/:id": (request, response, url, id) => {
      if (!readers(request, response)) return 0;
      if (off()) return fail(request, response, 503, "UNAVAILABLE", "Arsip tidak tersedia (mock).");
      if (!/^[1-9]\d*$/.test(id)) return invalid(request, response, { id: "Id tidak valid." });
      const row = ROWS.find((item) => item.id === Number(id));
      if (!row) return fail(request, response, 404, "NOT_FOUND", "Riwayat lama tidak ditemukan.");
      const imported = new Date(Date.now() - DAY_MS).toISOString();
      return send(request, response, 200, {
        trip: { ...listed(row), importedAt: imported, updatedAt: imported, details: row.details },
        group: row.groupId === null ? [] : ROWS.filter((item) => item.groupId === row.groupId && item.id !== row.id).map(listed),
        exceptions: EXCEPTIONS.filter((item) => item.legacyRegId === row.legacyId),
      });
    },
  };
}
