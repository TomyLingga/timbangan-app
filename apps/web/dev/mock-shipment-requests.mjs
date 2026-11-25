// Mock of the shipment requests of apps/api (src/shipment-requests/routes.ts, view.ts, and the request files of
// src/attachments/routes.ts), for dev/mock-api.mjs. Every number and name is made up.
//
// The INL team picks a purchase contract, attaches the contract PDF and sends the request to the supplier's accounts.
// A supplier account registers incoming trucks only on a contract with a SENT request (planRegistration in
// dev/mock-api.mjs asks hasSentRequest). DRAFT -> SENT -> CLOSED; DRAFT or SENT -> CANCELLED. One open request per
// contract.
//
// Seeded: the two open contracts of PKS Contoh A (the account pks.contoh.a registers on both in dev/smoke.mjs) have a
// request sent a few days ago, without a notification, so that account's inbox stays empty. PKS Contoh B has none.

export const MAX_REQUEST_FILES = 5;
const STATUSES = ["DRAFT", "SENT", "CLOSED", "CANCELLED"];
/** What a supplier account sees: requests sent to its company. */
const PARTNER_STATUSES = ["SENT", "CLOSED"];
const OPEN = ["DRAFT", "SENT"];
/** What may still change once the request has been sent. */
const LATE_FIELDS = new Set(["qtyPlanned", "deliveryUntil", "remark"]);
const QTY_MESSAGE = "Quantity harus angka lebih dari 0.";

const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function createShipmentRequestsMock({ guard, send, fail, invalid, readJson, contracts, users, storedFiles, publicAttachment, linkedAnywhere, notify, seedPdf }) {
  let nextId = 1;
  /** { id, status, contractId, partnerId, qtyPlanned, deliveryFrom, deliveryUntil, remark, files: [link], createdBy, createdAt, sentBy, ... } */
  const requests = [];
  const nowIso = () => new Date().toISOString();
  const person = (userId) => {
    const user = users.find((item) => item.id === userId);
    return user ? { id: user.id, fullName: user.fullName } : null;
  };
  const contractOf = (row) => contracts.find((item) => item.id === row.contractId);

  function view(row) {
    const contract = contractOf(row);
    return {
      id: row.id,
      status: row.status,
      contract: {
        id: contract.id,
        contractNo: contract.contractNo,
        state: contract.state,
        qtyContract: contract.qtyContract,
        uom: contract.uom,
        tolerancePct: contract.tolerancePct,
        validFrom: contract.validFrom,
        validUntil: contract.validUntil,
      },
      product: { id: contract.product.id, name: contract.product.name, category: contract.product.category },
      partner: { id: contract.partner.id, name: contract.partner.name },
      qtyPlanned: row.qtyPlanned,
      uom: contract.uom,
      deliveryFrom: row.deliveryFrom,
      deliveryUntil: row.deliveryUntil,
      remark: row.remark,
      fileCount: row.files.length,
      createdBy: person(row.createdBy) ?? { id: row.createdBy, fullName: null },
      createdAt: row.createdAt,
      sentBy: person(row.sentBy),
      sentAt: row.sentAt,
      closedBy: person(row.closedBy),
      closedAt: row.closedAt,
      cancelledBy: person(row.cancelledBy),
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      updatedAt: row.updatedAt,
    };
  }

  const visibleTo = (user, row) => user.kind !== "PARTNER" || (row.partnerId === user.partner?.id && PARTNER_STATUSES.includes(row.status));
  const notFound = (request, response) => fail(request, response, 404, "NOT_FOUND", "Permintaan pengiriman tidak ditemukan.");
  const openExists = (request, response) => fail(request, response, 409, "SHIPMENT_REQUEST_EXISTS", "Kontrak ini sudah punya permintaan pengiriman yang masih terbuka.");
  const purchaseContract = (id) => contracts.find((item) => String(item.id) === String(id) && item.direction === "IN" && item.state === "OPEN") ?? null;
  const otherOpen = (contractId, except) => requests.some((row) => row.contractId === contractId && OPEN.includes(row.status) && row.id !== except);

  /** The checks of the body shared by create and change; returns a fields object (empty when fine). */
  function checkFields(body) {
    const fields = {};
    if (body.qtyPlanned !== undefined && body.qtyPlanned !== null && !(typeof body.qtyPlanned === "number" && body.qtyPlanned > 0)) fields.qtyPlanned = QTY_MESSAGE;
    for (const [name, label] of [["deliveryFrom", "Tanggal mulai kirim"], ["deliveryUntil", "Tanggal akhir kirim"]]) {
      if (body[name] !== undefined && body[name] !== null && !isDate(body[name])) fields[name] = `${label} harus berformat YYYY-MM-DD.`;
    }
    if (body.remark !== undefined && body.remark !== null && (typeof body.remark !== "string" || body.remark.length > 1000)) fields.remark = "Keterangan terlalu panjang.";
    return fields;
  }
  const trimmed = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

  function seed() {
    const staff = users.find((user) => user.username === "admin.contoh");
    for (const contractNo of ["0123/CONTOH/CPO/XI/2026", "0124/CONTOH/CPO/XI/2026"]) {
      const contract = contracts.find((item) => item.contractNo === contractNo);
      if (!contract || !staff) continue;
      const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const fileId = seedPdf(`kontrak-${contractNo.slice(0, 4)}.pdf`);
      requests.push({
        id: `sr-${nextId++}`,
        status: "SENT",
        contractId: contract.id,
        partnerId: contract.partner.id,
        qtyPlanned: null,
        deliveryFrom: null,
        deliveryUntil: null,
        remark: null,
        files: [{ fileId, label: "Kontrak", addedAt: at, addedBy: { id: staff.id, fullName: staff.fullName } }],
        createdBy: staff.id,
        createdAt: at,
        sentBy: staff.id,
        sentAt: at,
        closedBy: null,
        closedAt: null,
        cancelledBy: null,
        cancelledAt: null,
        cancelReason: null,
        updatedAt: at,
      });
    }
  }
  seed();

  const find = (id) => requests.find((row) => row.id === id) ?? null;

  const routes = {
    "GET /api/shipment-requests": (request, response, url) => {
      const user = guard(request, response, [["shipment_requests", "VIEW"]]);
      if (!user) return 0;
      const status = url.searchParams.get("status") ?? "";
      if (status && !STATUSES.includes(status)) return invalid(request, response, { status: "Status permintaan tidak dikenal." });
      const contractId = url.searchParams.get("contractId");
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
      const matches = requests
        .filter((row) => visibleTo(user, row))
        .filter((row) => (!status || row.status === status) && (!contractId || row.contractId === contractId))
        .filter((row) => {
          if (!q) return true;
          const contract = contractOf(row);
          return contract.contractNo.toLowerCase().includes(q) || contract.partner.name.toLowerCase().includes(q);
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return send(request, response, 200, { items: matches.slice(0, limit).map(view), total: matches.length });
    },

    "GET /api/shipment-requests/:id": (request, response, url, id) => {
      const user = guard(request, response, [["shipment_requests", "VIEW"]]);
      if (!user) return 0;
      const row = find(id);
      if (!row || !visibleTo(user, row)) return notFound(request, response);
      return send(request, response, 200, { shipmentRequest: view(row), files: row.files.map(publicAttachment) });
    },

    "POST /api/shipment-requests": async (request, response) => {
      const user = guard(request, response, [["shipment_requests", "CREATE"]], { staffOnly: true });
      if (!user) return 0;
      const body = await readJson(request);
      if (body.contractId === undefined || body.contractId === null || body.contractId === "") return invalid(request, response, { contractId: "ID tidak valid." });
      const fields = checkFields(body);
      if (Object.keys(fields).length > 0) return invalid(request, response, fields);
      if (body.deliveryFrom && body.deliveryUntil && body.deliveryUntil < body.deliveryFrom) {
        return invalid(request, response, { deliveryUntil: "Tanggal akhir kirim tidak boleh sebelum tanggal mulai." });
      }
      const contract = purchaseContract(body.contractId);
      if (!contract) return invalid(request, response, { contractId: "Kontrak beli tidak ditemukan atau tidak terbuka." });
      if (otherOpen(contract.id, null)) return openExists(request, response);
      const at = nowIso();
      const row = {
        id: `sr-${nextId++}`,
        status: "DRAFT",
        contractId: contract.id,
        partnerId: contract.partner.id,
        qtyPlanned: body.qtyPlanned ?? null,
        deliveryFrom: body.deliveryFrom ?? null,
        deliveryUntil: body.deliveryUntil ?? null,
        remark: trimmed(body.remark),
        files: [],
        createdBy: user.id,
        createdAt: at,
        sentBy: null,
        sentAt: null,
        closedBy: null,
        closedAt: null,
        cancelledBy: null,
        cancelledAt: null,
        cancelReason: null,
        updatedAt: at,
      };
      requests.push(row);
      return send(request, response, 201, { shipmentRequest: view(row) });
    },

    "PATCH /api/shipment-requests/:id": async (request, response, url, id) => {
      const user = guard(request, response, [["shipment_requests", "EDIT"]], { staffOnly: true });
      if (!user) return 0;
      const row = find(id);
      if (!row) return notFound(request, response);
      const body = await readJson(request);
      const given = Object.keys(body).filter((key) => body[key] !== undefined);
      if (row.status === "SENT") {
        if (given.some((key) => !LATE_FIELDS.has(key))) {
          return fail(request, response, 409, "INVALID_STATE", "Setelah permintaan dikirim, hanya quantity, tanggal akhir kirim, dan keterangan yang boleh diubah.");
        }
      } else if (row.status !== "DRAFT") {
        return fail(request, response, 409, "INVALID_STATE", "Permintaan yang sudah ditutup atau dibatalkan tidak bisa diubah.");
      }
      const fields = checkFields(body);
      if (Object.keys(fields).length > 0) return invalid(request, response, fields);
      const changes = {};
      if (body.contractId !== undefined && String(body.contractId) !== String(row.contractId)) {
        const contract = purchaseContract(body.contractId);
        if (!contract) return invalid(request, response, { contractId: "Kontrak beli tidak ditemukan atau tidak terbuka." });
        if (otherOpen(contract.id, row.id)) return openExists(request, response);
        Object.assign(changes, { contractId: contract.id, partnerId: contract.partner.id });
      }
      for (const name of ["qtyPlanned", "deliveryFrom", "deliveryUntil"]) if (body[name] !== undefined) changes[name] = body[name];
      if (body.remark !== undefined) changes.remark = trimmed(body.remark);
      const from = changes.deliveryFrom !== undefined ? changes.deliveryFrom : row.deliveryFrom;
      const until = changes.deliveryUntil !== undefined ? changes.deliveryUntil : row.deliveryUntil;
      if (from && until && until < from) return invalid(request, response, { deliveryUntil: "Tanggal akhir kirim tidak boleh sebelum tanggal mulai." });
      if (Object.keys(changes).length > 0) Object.assign(row, changes, { updatedAt: nowIso() });
      return send(request, response, 200, { shipmentRequest: view(row) });
    },

    "POST /api/shipment-requests/:id/send": (request, response, url, id) => {
      const user = guard(request, response, [["shipment_requests", "EDIT"]], { staffOnly: true });
      if (!user) return 0;
      const row = find(id);
      if (!row) return notFound(request, response);
      if (row.status !== "DRAFT") return fail(request, response, 409, "INVALID_STATE", "Hanya permintaan berstatus DRAFT yang bisa dikirim.");
      if (contractOf(row)?.state !== "OPEN") return fail(request, response, 409, "INVALID_STATE", "Kontrak permintaan ini sudah tidak terbuka.");
      if (row.files.length === 0) return fail(request, response, 409, "FILE_REQUIRED", "Lampirkan dokumen kontrak sebelum permintaan dikirim.");
      const at = nowIso();
      Object.assign(row, { status: "SENT", sentBy: user.id, sentAt: at, updatedAt: at });
      notify({ id: row.id, contractNo: contractOf(row).contractNo, partnerId: row.partnerId });
      return send(request, response, 200, { shipmentRequest: view(row) });
    },

    "POST /api/shipment-requests/:id/close": (request, response, url, id) => {
      const user = guard(request, response, [["shipment_requests", "EDIT"]], { staffOnly: true });
      if (!user) return 0;
      const row = find(id);
      if (!row) return notFound(request, response);
      if (row.status !== "SENT") return fail(request, response, 409, "INVALID_STATE", "Hanya permintaan berstatus SENT yang bisa ditutup.");
      const at = nowIso();
      Object.assign(row, { status: "CLOSED", closedBy: user.id, closedAt: at, updatedAt: at });
      return send(request, response, 200, { shipmentRequest: view(row) });
    },

    "POST /api/shipment-requests/:id/cancel": async (request, response, url, id) => {
      const user = guard(request, response, [["shipment_requests", "EDIT"]], { staffOnly: true });
      if (!user) return 0;
      const row = find(id);
      if (!row) return notFound(request, response);
      const { reason } = await readJson(request);
      if (!trimmed(reason)) return invalid(request, response, { reason: "Alasan wajib diisi." });
      if (!OPEN.includes(row.status)) return fail(request, response, 409, "INVALID_STATE", "Permintaan ini sudah ditutup atau dibatalkan.");
      const at = nowIso();
      Object.assign(row, { status: "CANCELLED", cancelledBy: user.id, cancelledAt: at, cancelReason: reason.trim(), updatedAt: at });
      return send(request, response, 200, { shipmentRequest: view(row) });
    },

    "POST /api/shipment-requests/:id/files": async (request, response, url, id) => {
      const user = guard(request, response, [["shipment_requests", "CREATE"]], { staffOnly: true });
      if (!user) return 0;
      const row = find(id);
      if (!row) return notFound(request, response);
      if (!OPEN.includes(row.status)) return fail(request, response, 409, "INVALID_STATE", "Lampiran hanya bisa diubah selama permintaan berstatus DRAFT atau SENT.");
      const { fileId, label } = await readJson(request);
      const file = storedFiles.get(fileId);
      // a partner's upload is never handed to another company through a request
      if (!file || file.partnerId) return invalid(request, response, { fileId: "Berkas tidak ditemukan." });
      if (row.files.some((link) => link.fileId === fileId)) return fail(request, response, 409, "DUPLICATE", "Berkas ini sudah dilampirkan.");
      if (linkedAnywhere(fileId)) return invalid(request, response, { fileId: "Berkas ini sudah dipakai di tempat lain." });
      if (row.files.length >= MAX_REQUEST_FILES) return fail(request, response, 409, "TOO_MANY_FILES", `Paling banyak ${MAX_REQUEST_FILES} lampiran per permintaan.`);
      row.files.push({ fileId, label: trimmed(label), addedAt: nowIso(), addedBy: { id: user.id, fullName: user.fullName } });
      return send(request, response, 201, { files: row.files.map(publicAttachment) });
    },

    "DELETE /api/shipment-requests/:id/files/:fileId": (request, response, url, id, fileId) => {
      const user = guard(request, response, [["shipment_requests", "CREATE"]], { staffOnly: true });
      if (!user) return 0;
      const row = find(id);
      if (!row) return notFound(request, response);
      if (!OPEN.includes(row.status)) return fail(request, response, 409, "INVALID_STATE", "Lampiran hanya bisa diubah selama permintaan berstatus DRAFT atau SENT.");
      const left = row.files.filter((link) => link.fileId !== fileId);
      if (left.length === row.files.length) return fail(request, response, 404, "NOT_FOUND", "Lampiran tidak ditemukan.");
      // the supplier keeps the contract document it was sent: add the new file first, then remove the old one
      if (row.status === "SENT" && left.length === 0) return fail(request, response, 409, "FILE_REQUIRED", "Permintaan yang sudah dikirim harus tetap punya satu lampiran.");
      row.files = left;
      return send(request, response, 200, { files: row.files.map(publicAttachment) });
    },
  };

  /** Whether the file is attached to any request. */
  const linked = (fileId) => requests.some((row) => row.files.some((link) => link.fileId === fileId));

  return {
    routes,
    linked,
    /** A supplier reads the PDF of a request sent to its company (SENT or CLOSED). */
    partnerMayRead: (user, fileId) =>
      requests.some((row) => row.partnerId === user.partner?.id && PARTNER_STATUSES.includes(row.status) && row.files.some((link) => link.fileId === fileId)),
    /** Whether the contract has a request sent to this supplier and not closed or cancelled. */
    hasSentRequest: (contractId, partnerId) => requests.some((row) => row.contractId === contractId && row.partnerId === partnerId && row.status === "SENT"),
    /** The open request of a contract as GET /api/contracts shows it: DRAFT or SENT for staff, SENT only for a partner. */
    openRequestOf: (contractId, user) => {
      const allowed = user.kind === "PARTNER" ? ["SENT"] : OPEN;
      const row = requests.find((item) => item.contractId === contractId && allowed.includes(item.status));
      return row ? { id: row.id, status: row.status, sentAt: row.sentAt } : null;
    },
  };
}
