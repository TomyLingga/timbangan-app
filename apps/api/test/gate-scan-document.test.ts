// POST /api/gate/scan-document: the scan is stored, the stand-in reading service reads it, and the answer is a
// proposal: the reading, its match against the master data, and a registration body when nothing is left open.
import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { letterAnswer, NO_FIELD_FOUND, orderAnswer, startFakeOcr } from "./helpers/fake-ocr.js";
import { multipart, PNG_BYTES } from "./helpers/field.js";
import { seedCompany, seedContract } from "./helpers/fixtures.js";
import { bearer, DESK, seedStaff } from "./helpers/users.js";
import { JPEG_BYTES, storedFiles, walkInApp } from "./helpers/walk-in.js";

const fieldOf = (proposal: { read: { fields: { key: string }[] } }, key: string) => proposal.read.fields.find((field) => field.key === key);
const missingFields = (proposal: { missing: { field: string }[] }) => proposal.missing.map((item) => item.field);

describe("POST /api/gate/scan-document, incoming", () => {
  it("stores the scan, sends it to the reading service, and proposes a registration the registration route takes", async () => {
    const { scan, ocr, database, config, ids, companies, products, contracts, vehicles, drivers, call } = await walkInApp();
    ocr.answer(
      letterAnswer(
        {},
        {
          perlu_cek_manual: { ...(letterAnswer().perlu_cek_manual as object), no_sim: true, ullage: true },
          perbaikan: { no_sim: "keyakinan baca rendah", unit_usaha: "dicocokkan ke daftar induk (kemiripan 1.0)" },
        },
      ),
    );
    const response = await scan("IN", { name: "surat masuk.jpg" });
    expect(response.statusCode, response.body).toBe(200);
    const proposal = response.json();

    // the service got the image as the one multipart field `file`, on the incoming path
    expect(ocr.calls).toHaveLength(1);
    expect(ocr.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/surat-masuk/scan" });
    expect(ocr.calls[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(ocr.calls[0]?.body.includes(JPEG_BYTES)).toBe(true);
    expect(ocr.calls[0]?.body.toString("latin1")).toContain('name="file"; filename="scan.jpg"');

    // the scan is kept as a file of kind SCAN, typed by its bytes
    expect(proposal.scan).toEqual({ fileId: expect.any(Number), originalName: "surat masuk.jpg", mimeType: "image/jpeg", sizeBytes: JPEG_BYTES.length });
    const [file] = await database.query<{ kind: string; storage_key: string; uploaded_by: number }>("select kind, storage_key, uploaded_by::int as uploaded_by from files where id = $1", [proposal.scan.fileId]);
    expect(file).toMatchObject({ kind: "SCAN", uploaded_by: ids.pos });
    expect(await readFile(join(config.files.dir, String(file?.storage_key)))).toEqual(JPEG_BYTES);
    expect(await database.query("select action, entity_type, entity_id::int as entity_id, after from audit_log where action = 'DOCUMENT_SCANNED'")).toEqual([
      { action: "DOCUMENT_SCANNED", entity_type: "file", entity_id: proposal.scan.fileId, after: { direction: "IN", outcome: "READ", fieldsFound: 12, fieldsTotal: 12 } },
    ]);

    // what was read, with the flag and the reason of the service passed through
    expect(proposal).toMatchObject({ direction: "IN", unreadable: false, read: { fieldsFound: 12, fieldsTotal: 12, warnings: [], extraLines: [] }, timing: { ocrMs: expect.any(Number) } });
    expect(proposal.read.fields).toHaveLength(18);
    expect(fieldOf(proposal, "nomor_kontrak")).toEqual({ key: "nomor_kontrak", label: "Nomor kontrak", value: "0012/UJI/CPO-L/XI/2026", needsCheck: false, reason: null });
    expect(fieldOf(proposal, "no_sim")).toEqual({ key: "no_sim", label: "Nomor SIM", value: "SIMSURAT0001", needsCheck: true, reason: "keyakinan baca rendah" });
    expect(fieldOf(proposal, "unit_usaha")).toMatchObject({ needsCheck: false, reason: "dicocokkan ke daftar induk (kemiripan 1.0)" });
    expect(fieldOf(proposal, "brutto_kg")).toMatchObject({ label: "Bruto (kg)", value: 40120 });
    expect(fieldOf(proposal, "ullage")).toMatchObject({ value: null, needsCheck: true });

    // every value found in the master data
    expect(proposal.matches.supplier).toEqual({ status: "EXACT", read: "PT. SAWIT SATU", value: { id: companies.supplier1, name: "PT Sawit Satu" }, candidates: [], note: null });
    expect(proposal.matches.transporter).toEqual({ status: "EXACT", read: "PT. ANGKUT SATU", value: { id: companies.transporter1, name: "PT Angkut Satu" }, candidates: [], note: null });
    expect(proposal.matches.contracts).toEqual([
      {
        status: "EXACT",
        read: "0012/UJI/CPO-L/XI/2026",
        value: {
          id: contracts.main,
          contractNo: "0012/UJI/CPO-L/XI/2026",
          partner: { id: companies.supplier1, name: "PT Sawit Satu" },
          product: { id: products.cpo, name: "Minyak Contoh Mentah", category: "CPO" },
          qtyContract: null,
          uom: "kg",
          validUntil: null,
          supplierMatches: true,
        },
        candidates: [],
        note: null,
      },
    ]);
    expect(proposal.matches.vehicle).toEqual({
      status: "EXACT",
      read: "BK 5001 EE",
      value: { id: vehicles.letter, plateNo: "BK5001EE", plateDisplay: "BK 5001 EE", vehicleTypeCode: "TANGKI", needsContainerNo: false, owner: { id: companies.transporter1, name: "PT Angkut Satu" }, verified: true },
      candidates: [],
      note: null,
      isNew: false,
    });
    expect(proposal.matches.driver).toEqual({
      status: "EXACT",
      read: { fullName: "SUPIR SURAT SATU", licenceNo: "SIMSURAT0001" },
      value: { id: drivers.letter, fullName: "Supir Surat Satu", licenceNo: "SIMSURAT0001", licenceClass: "B2 UMUM", licenceValidUntil: "2028-01-31", registryStatus: "NORMAL" },
      candidates: [],
      note: null,
      isNew: false,
    });
    expect(proposal.letter).toEqual({
      spbNo: "0456/MS/UJI/XI/2026",
      spbDate: "2026-11-19",
      lines: [{ seq: 1, contractNo: "0012/UJI/CPO-L/XI/2026", handoverNo: "OP-77/UJI", grossKg: 40120, tareKg: 12030, netKg: 28090, netConsistent: true, netNote: null }],
      quality: { FFA: 3.58, MOISTURE: 0.19, IMPURITIES: 0.019 },
    });

    // nothing is left to choose: the body is complete, and it is what the draft holds
    const body = {
      direction: "IN",
      submit: true,
      plannedDate: "2026-11-20",
      transporterId: companies.transporter1,
      // asal PKS from the mill's name on the letter (0018)
      originPartnerId: companies.supplier1,
      allocations: [{ contractId: contracts.main }],
      trips: [
        {
          vehicle: { id: vehicles.letter },
          driver: { id: drivers.letter },
          plannedArrival: "2026-11-20",
          letters: [
            { allocationSeq: 1, handoverNo: "OP-77/UJI", spbNo: "0456/MS/UJI/XI/2026", spbDate: "2026-11-19", originGrossKg: 40120, originTareKg: 12030, originNetKg: 28090, quality: { FFA: 3.58, MOISTURE: 0.19, IMPURITIES: 0.019 } },
          ],
        },
      ],
    };
    expect(proposal.missing).toEqual([]);
    expect(proposal.registration).toEqual(body);
    expect(proposal.draft).toEqual(body);
    // the scan itself changed nothing but the file and its audit line
    expect(await database.query("select count(*)::int as n from registrations")).toEqual([{ n: 0 }]);
    const registered = await call("POST", "/api/registrations", "pos", proposal.registration);
    expect(registered.statusCode, registered.body).toBe(201);
    expect(registered.json().registration).toMatchObject({ status: "APPROVED", transporter: { id: companies.transporter1 }, originPartner: { id: companies.supplier1, name: "PT Sawit Satu" }, trips: [{ docNetKg: 28090, allocations: [{ spbNo: "0456/MS/UJI/XI/2026", quality: { FFA: 3.58 } }] }] });
  });

  it("offers the open contracts near a number that is two characters off, and leaves the choice to the operator", async () => {
    const { scanOk, ocr, contracts } = await walkInApp();
    // IX for XI: two characters; the next contract of the same month is three away from what was read
    ocr.answer(letterAnswer({ nomor_kontrak: "0012/UJI/CPO-L/IX/2026" }));
    const proposal = await scanOk("IN");
    const [contract] = proposal.matches.contracts;
    expect(contract).toMatchObject({ status: "CLOSE", read: "0012/UJI/CPO-L/IX/2026", value: null, note: null });
    expect(contract.candidates).toEqual([expect.objectContaining({ id: contracts.main, contractNo: "0012/UJI/CPO-L/XI/2026", distance: 2, lookalikeOnly: false, supplierMatches: true })]);
    expect(proposal.registration).toBeNull();
    expect(proposal.missing).toEqual([{ field: "allocations.0.contractId", message: "Nomor kontrak tidak persis sama. Pilih kontrak yang benar." }]);
    // the rest of the body is ready; the allocation waits for the contract
    expect(proposal.draft).toMatchObject({ allocations: [{}], trips: [{ letters: [{ allocationSeq: 1, originNetKg: 28090 }] }] });

    // O read for 0 three times: more than two characters, but the same number once the lookalikes are folded
    ocr.answer(letterAnswer({ nomor_kontrak: "OO12/UJI/CPO-L/XI/2O26" }));
    const folded = (await scanOk("IN")).matches.contracts[0];
    expect(folded.status).toBe("CLOSE");
    expect(folded.candidates).toEqual([expect.objectContaining({ id: contracts.main, distance: 3, lookalikeOnly: true })]);

    // punctuation and case do not count: this is the contract itself
    ocr.answer(letterAnswer({ nomor_kontrak: "0012-uji / cpo l.XI.2026" }));
    expect((await scanOk("IN")).matches.contracts[0]).toMatchObject({ status: "EXACT", value: { id: contracts.main } });
  });

  it("puts the contracts of the supplier the mill's name points to before nearer ones of another supplier", async () => {
    const { scanOk, ocr, database, companies, products } = await walkInApp();
    const far = await seedContract(database, { no: "0044/UJI/CPO-L/X/2026", partnerId: companies.supplier1, productId: products.cpo });
    const near = await seedContract(database, { no: "0044/UJI/CPO-L/XI/2026", partnerId: companies.supplier2, productId: products.cpo });
    // XII read: one character from the other supplier's XI, two from this supplier's X
    ocr.answer(letterAnswer({ nomor_kontrak: "0044/UJI/CPO-L/XII/2026" }));
    const preferred = (await scanOk("IN")).matches.contracts[0].candidates;
    expect(preferred.map((candidate: { id: number; distance: number; supplierMatches: boolean }) => [candidate.id, candidate.distance, candidate.supplierMatches])).toEqual([
      [far, 2, true],
      [near, 1, false],
    ]);

    // an exact number settles the contract even when the mill's name points to another supplier; that is told
    ocr.answer(letterAnswer({ unit_usaha: "PT SAWIT DUA" }));
    const other = await scanOk("IN");
    expect(other.matches.supplier).toMatchObject({ status: "EXACT", value: { id: companies.supplier2 } });
    expect(other.matches.contracts[0]).toMatchObject({ status: "EXACT", value: { supplierMatches: false }, note: "Kontrak ini milik PT Sawit Satu, berbeda dari unit usaha di surat." });
    expect(other.registration).not.toBeNull();

    // a mill nobody knows: no supplier to prefer, so the nearest comes first
    ocr.answer(letterAnswer({ nomor_kontrak: "0044/UJI/CPO-L/XII/2026", unit_usaha: "PKS ENTAH DI MANA" }));
    const plain = await scanOk("IN");
    expect(plain.matches.supplier).toMatchObject({ status: "NONE", candidates: [] });
    expect(plain.matches.contracts[0].candidates.map((candidate: { id: number; supplierMatches: boolean | null }) => [candidate.id, candidate.supplierMatches])).toEqual([
      [near, null],
      [far, null],
    ]);
  });

  it("says when the exact contract is closed, and when a number has more than one line", async () => {
    const { scanOk, ocr, database, companies, products, contracts } = await walkInApp();
    ocr.answer(letterAnswer({ nomor_kontrak: "0855/UJI/CPO-L/V/2025" }));
    const closed = (await scanOk("IN")).matches.contracts[0];
    expect(closed).toMatchObject({ status: "NONE", value: null, candidates: [], note: "Kontrak 0855/UJI/CPO-L/V/2025 sudah ditutup atau dibatalkan." });

    const second = await seedContract(database, { no: "0012/UJI/CPO-L/XI/2026", partnerId: companies.supplier1, productId: products.olein });
    const twice = (await scanOk("IN")).matches.contracts[0];
    expect(twice).toMatchObject({ status: "CLOSE", value: null, note: "Nomor kontrak ini punya lebih dari satu baris barang. Pilih salah satu." });
    expect(twice.candidates.map((candidate: { id: number; distance: number }) => [candidate.id, candidate.distance])).toEqual([
      [contracts.main, 0],
      [second, 0],
    ]);
  });

  it("proposes a new vehicle and a new driver, and lists what is missing, for a letter that matches nothing", async () => {
    const { scanOk, ocr } = await walkInApp();
    ocr.answer(
      letterAnswer({
        nomor_kontrak: "7777/LAIN/CPO/I/2020",
        unit_usaha: "PKS ENTAH DI MANA",
        transporter: "CV TIDAK DIKENAL",
        no_polisi: "BK 9090 ZZ",
        nama_supir: "ORANG BARU SEKALI",
        no_sim: "9988-7766-5544",
      }),
    );
    const proposal = await scanOk("IN");
    expect(proposal.matches.supplier).toMatchObject({ status: "NONE", value: null, candidates: [] });
    expect(proposal.matches.transporter).toMatchObject({ status: "NONE", value: null, candidates: [] });
    expect(proposal.matches.contracts).toEqual([{ status: "NONE", read: "7777/LAIN/CPO/I/2020", value: null, candidates: [], note: null }]);
    expect(proposal.matches.vehicle).toEqual({
      status: "NONE", read: "BK 9090 ZZ", value: null, candidates: [], isNew: true, note: "Plat belum terdaftar. Kendaraan baru dibuat saat registrasi; pilih jenis kendaraannya.",
    });
    expect(proposal.matches.driver).toEqual({
      status: "NONE", read: { fullName: "ORANG BARU SEKALI", licenceNo: "9988-7766-5544" }, value: null, candidates: [], isNew: true,
      note: "Supir belum terdaftar. Supir baru dibuat saat registrasi; isi jenis dan masa berlaku SIM.",
    });
    expect(proposal.registration).toBeNull();
    expect(missingFields(proposal)).toEqual([
      "allocations.0.contractId", "transporterId", "trips.0.vehicle.vehicleTypeCode", "trips.0.driver.licenceClass", "trips.0.driver.licenceValidUntil",
    ]);
    // the draft carries what the registration route needs to create the two rows, as read
    expect(proposal.draft).toMatchObject({
      direction: "IN",
      allocations: [{}],
      trips: [{ vehicle: { plateDisplay: "BK 9090 ZZ" }, driver: { licenceNo: "9988-7766-5544", fullName: "ORANG BARU SEKALI" } }],
    });
    expect(proposal.draft.transporterId).toBeUndefined();
  });

  it("offers drivers by name when the licence number is not in the master, and partners by a near name", async () => {
    const { scanOk, ocr, drivers, companies, database } = await walkInApp();
    await database.query("update drivers set is_active = false where id = $1", [drivers.other]);
    // the licence is misread; the name is one character off; the inactive namesake is not offered
    ocr.answer(letterAnswer({ no_sim: "SIMSURAT0O07", nama_supir: "SUPIR SURAT SATV", transporter: "ANGKUT SATU, PT", unit_usaha: "PKS SAWIT SATU" }));
    const proposal = await scanOk("IN");
    expect(proposal.matches.driver).toMatchObject({ status: "CLOSE", value: null, isNew: false });
    expect(proposal.matches.driver.candidates).toEqual([
      { id: drivers.letter, fullName: "Supir Surat Satu", licenceNo: "SIMSURAT0001", licenceClass: "B2 UMUM", licenceValidUntil: "2028-01-31", registryStatus: "NORMAL", distance: 1 },
    ]);
    expect(proposal.matches.transporter).toMatchObject({ status: "EXACT", value: { id: companies.transporter1 } });
    // the mill's name holds the supplier's name: offered, not taken
    expect(proposal.matches.supplier).toMatchObject({ status: "CLOSE", value: null, candidates: [{ id: companies.supplier1, name: "PT Sawit Satu", distance: null }] });
    expect(proposal.matches.contracts[0]).toMatchObject({ status: "EXACT", value: { supplierMatches: true } });
    expect(proposal.registration).toBeNull();
    expect(proposal.missing).toEqual([{ field: "trips.0.driver", message: "Pilih supir dari kandidat, atau isi data supir baru." }]);
    expect(proposal.draft.trips[0].driver).toEqual({ licenceNo: "SIMSURAT0O07", fullName: "SUPIR SURAT SATV" });

    // found by the licence number but switched off: neither taken nor proposed as new
    ocr.answer(letterAnswer({ no_sim: "SIMSURAT0002", nama_supir: "SUPIR SURAT DUA" }));
    const inactive = await scanOk("IN");
    expect(inactive.matches.driver).toMatchObject({ status: "NONE", value: null, candidates: [], isNew: false, note: "Supir Supir Surat Dua dengan nomor SIM ini nonaktif. Pilih supir lain." });
    expect(inactive.draft.trips[0].driver).toEqual({});
    expect(missingFields(inactive)).toEqual(["trips.0.driver"]);
  });

  it("counts a document as unreadable when fewer than half of its fields were found, or the service found none", async () => {
    const { scan, scanOk, ocr, database, config } = await walkInApp();
    const answer = letterAnswer();
    ocr.answer({ ...answer, yolo: { ...(answer.yolo as object), field_ditemukan: 5, field_total: 12 }, peringatan: ["YOLO cuma menemukan 5 dari 12 field"] });
    const few = await scanOk("IN");
    expect(few).toMatchObject({ unreadable: true, registration: null, read: { fieldsFound: 5, fieldsTotal: 12, warnings: ["YOLO cuma menemukan 5 dari 12 field"] } });
    expect(few.missing).toEqual([{ field: "document", message: "Dokumen tidak terbaca dengan baik. Periksa semua isian sebelum menyimpan." }]);
    // exactly half is still a reading
    ocr.answer({ ...answer, yolo: { ...(answer.yolo as object), field_ditemukan: 6, field_total: 12 } });
    expect((await scanOk("IN")).unreadable).toBe(false);

    ocr.answer(NO_FIELD_FOUND.body, NO_FIELD_FOUND.status);
    const none = await scan("IN");
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json()).toMatchObject({
      unreadable: true,
      registration: null,
      read: { fieldsFound: null, fieldsTotal: null, fields: [], warnings: ["Layanan baca dokumen tidak menemukan isi surat pada gambar ini."] },
      matches: { contracts: [{ status: "NONE", read: null }], vehicle: { status: "NONE", isNew: false }, driver: { status: "NONE", isNew: false } },
    });
    // nothing was read, so nothing is proposed as new: every part is for the operator
    expect(missingFields(none.json())).toEqual(["document", "allocations.0.contractId", "trips.0.vehicle", "trips.0.driver"]);
    expect(none.json().draft).toMatchObject({ allocations: [{}], trips: [{ vehicle: {}, driver: {}, letters: [{ allocationSeq: 1 }] }] });
    // an answer that is not a reading at all is the same case
    ocr.answer("<html>proxy error</html>");
    expect((await scanOk("IN")).unreadable).toBe(true);

    // the scan is kept either way, and the audit line says which scans were not read
    expect((await storedFiles(config.files.dir)).length).toBe(4);
    expect((await database.query<{ outcome: string }>("select after->>'outcome' as outcome from audit_log where action = 'DOCUMENT_SCANNED' order by id")).map((row) => row.outcome)).toEqual([
      "UNREADABLE", "READ", "UNREADABLE", "UNREADABLE",
    ]);
  });

  it("says when net is not gross minus tare, and when the service could not check it", async () => {
    const { scanOk, ocr } = await walkInApp();
    ocr.answer(letterAnswer({ netto_kg: 28190 }));
    const wrong = await scanOk("IN");
    expect(wrong.letter.lines).toEqual([expect.objectContaining({ grossKg: 40120, tareKg: 12030, netKg: 28190, netConsistent: false, netNote: "Netto tidak sama dengan bruto dikurangi tarra." })]);
    expect(wrong.registration).toBeNull();
    expect(wrong.missing).toEqual([{ field: "trips.0.letters.0.originNetKg", message: "Netto tidak sama dengan bruto dikurangi tarra. Periksa angka berat." }]);
    expect(wrong.draft.trips[0].letters[0]).toMatchObject({ originGrossKg: 40120, originTareKg: 12030, originNetKg: 28190 });

    // one figure was worked out from the other two: the three agree, which proves nothing
    const reason = "salah satu angka berat dihitung dari rumus netto = brutto - tarra";
    ocr.answer(letterAnswer({}, { validasi: { netto_konsisten: null, netto_konsisten_alasan: reason } }));
    const derived = await scanOk("IN");
    expect(derived.letter.lines[0]).toMatchObject({ netConsistent: null, netNote: reason });
    expect(derived.registration).not.toBeNull();

    // a figure that was not read: nothing to compare, and the letter goes on without it
    ocr.answer(letterAnswer({ brutto_kg: null }));
    const partial = await scanOk("IN");
    expect(partial.letter.lines[0]).toMatchObject({ grossKg: null, netKg: 28090, netConsistent: null, netNote: "ada angka berat yang gagal dibaca" });
    expect(partial.registration.trips[0].letters[0]).toEqual(expect.not.objectContaining({ originGrossKg: expect.anything() }));

    // values the registration would refuse are left out of the body and stay visible in the reading
    ocr.answer(letterAnswer({ tanggal_spb: "2026-02-31", brutto_kg: 40120.5, ffa: 55, nomor_spb: "X".repeat(61) }));
    const odd = await scanOk("IN");
    expect(odd.letter).toMatchObject({ spbNo: null, spbDate: null, quality: { MOISTURE: 0.19, IMPURITIES: 0.019 }, lines: [{ grossKg: null, netKg: 28090 }] });
    expect(fieldOf(odd, "tanggal_spb")).toMatchObject({ value: "2026-02-31" });
    expect(odd.registration.trips[0].letters[0]).toEqual({ allocationSeq: 1, handoverNo: "OP-77/UJI", originTareKg: 12030, originNetKg: 28090, quality: { MOISTURE: 0.19, IMPURITIES: 0.019 } });
  });

  it("reads a letter that carries two contracts as two allocations with a letter each", async () => {
    const { scanOk, ocr, contracts } = await walkInApp();
    const answer = letterAnswer();
    ocr.answer({
      ...answer,
      baris: [
        ...(answer.baris as object[]),
        { nomor_kontrak: "0013/UJI/CPO-L/XI/2026", no_order_penyerahan: "OP-78/UJI", brutto_kg: 14030, tarra_kg: 12030, netto_kg: 2000 },
      ],
      perlu_cek_manual: { ...(answer.perlu_cek_manual as object), nomor_kontrak_baris2: true, netto_kg_baris2: true },
    });
    const proposal = await scanOk("IN");
    expect(proposal.matches.contracts.map((match: { status: string; value: { id: number } }) => [match.status, match.value.id])).toEqual([
      ["EXACT", contracts.main],
      ["EXACT", contracts.next],
    ]);
    expect(proposal.letter.lines).toMatchObject([
      { seq: 1, netKg: 28090, netConsistent: true },
      { seq: 2, contractNo: "0013/UJI/CPO-L/XI/2026", handoverNo: "OP-78/UJI", grossKg: 14030, tareKg: 12030, netKg: 2000, netConsistent: true },
    ]);
    expect(proposal.read.extraLines).toHaveLength(1);
    expect(proposal.read.extraLines[0]).toContainEqual({ key: "nomor_kontrak", label: "Nomor kontrak", value: "0013/UJI/CPO-L/XI/2026", needsCheck: true, reason: null });
    expect(proposal.registration).toMatchObject({
      allocations: [{ contractId: contracts.main }, { contractId: contracts.next }],
      trips: [{ letters: [{ allocationSeq: 1, originNetKg: 28090 }, { allocationSeq: 2, handoverNo: "OP-78/UJI", spbNo: "0456/MS/UJI/XI/2026", originNetKg: 2000 }] }],
    });
  });
});

describe("POST /api/gate/scan-document, outgoing", () => {
  it("finds the delivery order by its number, with the transporter, product and destination that follow from it", async () => {
    const { scanOk, ocr, deliveryOrder, companies, products } = await walkInApp();
    const order = await deliveryOrder(250_000);
    ocr.answer(orderAnswer({ nomor_do: order.doNo.toLowerCase().replaceAll("/", " / ") }));
    const proposal = await scanOk("OUT");
    expect(ocr.calls.at(-1)?.path).toBe("/api/v1/surat-keluar/scan");
    expect(proposal).toMatchObject({ direction: "OUT", unreadable: false, read: { fieldsFound: 9, fieldsTotal: 9 } });
    expect(proposal.letter).toBeUndefined();
    expect(fieldOf(proposal, "pengangkut")).toMatchObject({ label: "Pengangkut", value: "PT. ANGKUT SATU" });
    expect(proposal.matches.deliveryOrder).toMatchObject({
      status: "EXACT",
      value: {
        id: order.id,
        doNo: order.doNo,
        status: "ACCEPTED",
        partner: { id: companies.customer1 },
        product: { id: products.olein, name: "Minyak Contoh Olahan" },
        transporter: { id: companies.transporter1, name: "PT Angkut Satu" },
        destination: { name: "Gudang Contoh", regency: "Kab. Contoh" },
        qty: 250000,
        qtyRemaining: 250000,
      },
      candidates: [],
      note: null,
    });
    // a delivery order names neither the truck nor the driver: the operator chooses both
    expect(proposal.registration).toBeNull();
    expect(proposal.draft).toEqual({
      direction: "OUT", submit: true, plannedDate: "2026-11-20", allocations: [{ deliveryOrderId: order.id }], trips: [{ vehicle: {}, driver: {}, plannedArrival: "2026-11-20" }],
    });
    expect(missingFields(proposal)).toEqual(["allocations.0.qtyPlanned", "trips.0.vehicle", "trips.0.driver", "closeCargo", "flexiBag"]);
  });

  it("offers the accepted orders near a number that is off, and says when the exact one may not be loaded yet", async () => {
    const { scanOk, ocr, deliveryOrder } = await walkInApp();
    const first = await deliveryOrder(100_000);
    const second = await deliveryOrder(100_000);
    const waiting = await deliveryOrder(100_000, false);
    expect([first.doNo.slice(0, 3), second.doNo.slice(0, 3), waiting.doNo.slice(0, 3)]).toEqual(["001", "002", "003"]);

    // 001 read as 007: one character from 001 and one from 002; the order still waiting is not offered
    ocr.answer(orderAnswer({ nomor_do: first.doNo.replace("001", "007") }));
    const near = await scanOk("OUT");
    expect(near.matches.deliveryOrder).toMatchObject({ status: "CLOSE", value: null, note: null });
    expect(near.matches.deliveryOrder.candidates.map((candidate: { id: number; distance: number }) => [candidate.id, candidate.distance])).toEqual([
      [first.id, 1],
      [second.id, 1],
    ]);
    expect(near.draft.allocations).toEqual([{}]);
    expect(near.missing[0]).toEqual({ field: "allocations.0.deliveryOrderId", message: "Nomor DO tidak persis sama. Pilih DO yang benar." });

    ocr.answer(orderAnswer({ nomor_do: waiting.doNo }));
    const sent = (await scanOk("OUT")).matches.deliveryOrder;
    expect(sent).toMatchObject({ status: "CLOSE", value: null, note: `DO ${waiting.doNo} berstatus SENT: belum diterima transporter atau sudah ditutup.` });
    expect(sent.candidates.map((candidate: { id: number }) => candidate.id).sort()).toEqual([first.id, second.id]);

    ocr.answer(orderAnswer({ nomor_do: null }));
    const unread = await scanOk("OUT");
    expect(unread.matches.deliveryOrder).toEqual({ status: "NONE", read: null, value: null, candidates: [], note: null });
    expect(unread.missing[0]).toEqual({ field: "allocations.0.deliveryOrderId", message: "Nomor DO tidak terbaca. Pilih DO." });
  });
});

describe("POST /api/gate/scan-document, the reading service", () => {
  it("answers 503 without OCR_API_URL and stores nothing", async () => {
    const { scan, database, config, ocr } = await walkInApp({}, { ocrUrl: null });
    const response = await scan("IN");
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toEqual({ code: "NOT_CONFIGURED", message: "Layanan baca dokumen belum diatur di server." });
    expect(await database.query("select count(*)::int as n from files")).toEqual([{ n: 0 }]);
    expect(await storedFiles(config.files.dir)).toEqual([]);
    expect(ocr.calls).toEqual([]);
  });

  it("answers a clear error when the service is down or broken, and keeps the scan", async () => {
    const { scan, ocr, database, config } = await walkInApp();
    ocr.answer({ detail: "Model YOLO belum dipasang." }, 503);
    const broken = await scan("IN");
    expect(broken.statusCode).toBe(502);
    expect(broken.json().error).toEqual({ code: "OCR_FAILED", message: "Layanan baca dokumen sedang bermasalah (HTTP 503). Scan sudah disimpan. Coba pindai lagi.", scanFileId: expect.any(Number) });

    await ocr.close();
    const down = await scan("OUT");
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toEqual({ code: "OCR_UNAVAILABLE", message: "Layanan baca dokumen tidak dapat dihubungi. Scan sudah disimpan. Coba pindai lagi.", scanFileId: expect.any(Number) });

    const rows = await database.query<{ id: number; kind: string; storage_key: string }>("select id::int as id, kind, storage_key from files order by id");
    expect(rows.map((row) => [row.id, row.kind])).toEqual([
      [broken.json().error.scanFileId, "SCAN"],
      [down.json().error.scanFileId, "SCAN"],
    ]);
    expect((await storedFiles(config.files.dir)).sort()).toEqual(rows.map((row) => row.storage_key).sort());
    expect((await database.query<{ outcome: string }>("select after->>'outcome' as outcome from audit_log where action = 'DOCUMENT_SCANNED' order by id")).map((row) => row.outcome)).toEqual([
      "OCR_FAILED", "OCR_UNAVAILABLE",
    ]);
  });

  it("gives up after OCR_TIMEOUT_S and keeps the scan", async () => {
    const { scan, ocr, database } = await walkInApp({ OCR_TIMEOUT_S: "1" });
    const release = ocr.hold();
    const started = Date.now();
    const response = await scan("IN");
    release();
    expect(response.statusCode).toBe(504);
    expect(response.json().error).toEqual({ code: "OCR_TIMEOUT", message: "Layanan baca dokumen tidak menjawab dalam 1 detik. Scan sudah disimpan. Coba pindai lagi.", scanFileId: expect.any(Number) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await database.query("select kind from files where id = $1", [response.json().error.scanFileId])).toEqual([{ kind: "SCAN" }]);
  });
});

describe("POST /api/gate/scan-document, the request", () => {
  it("takes a JPG or PNG up to 15 MB with the direction before or after the file, and refuses the rest without storing it", async () => {
    const { scan, app, database, ocr } = await walkInApp();
    expect((await scan("IN", { bytes: PNG_BYTES, name: "surat.png" })).json().scan).toMatchObject({ mimeType: "image/png" });
    expect(ocr.calls[0]?.body.toString("latin1")).toContain('filename="scan.png"');

    // a browser may send the fields in either order
    const boundary = "----ujiurutan";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="do.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      JPEG_BYTES,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="direction"\r\n\r\nOUT\r\n--${boundary}--\r\n`),
    ]);
    const headers = { ...(await bearer(app, "pos")), "content-type": `multipart/form-data; boundary=${boundary}` };
    const after = await app.inject({ method: "POST", url: "/api/gate/scan-document", headers, payload });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().direction).toBe("OUT");
    const kept = async () => Number((await database.query<{ n: number }>("select count(*)::int as n from files"))[0]?.n);
    expect(await kept()).toBe(2);

    const fieldsOf = async (response: Promise<{ statusCode: number; json: () => { error: { fields: unknown } } }>) => {
      const answer = await response;
      expect(answer.statusCode).toBe(400);
      return answer.json().error.fields;
    };
    expect(await fieldsOf(scan(null))).toEqual([{ field: "direction", message: "Arah harus IN atau OUT." }]);
    expect(await fieldsOf(scan("MASUK"))).toEqual([{ field: "direction", message: "Arah harus IN atau OUT." }]);
    expect(await fieldsOf(scan("IN", { bytes: Buffer.from("%PDF-1.7 contoh") }))).toEqual([{ field: "file", message: "Scan harus gambar JPG atau PNG." }]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32, 1)]);
    expect(await fieldsOf(scan("IN", { bytes: webp }))).toEqual([{ field: "file", message: "Scan harus gambar JPG atau PNG." }]);
    expect(await fieldsOf(app.inject({ method: "POST", url: "/api/gate/scan-document", headers: await bearer(app, "pos"), payload: { direction: "IN" } }))).toEqual([
      { field: "file", message: "Kirim satu berkas sebagai multipart/form-data." },
    ]);

    const limit = 15 * 1024 * 1024;
    const big = await scan("IN", { bytes: Buffer.concat([JPEG_BYTES, Buffer.alloc(limit)]) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toEqual({ code: "FILE_TOO_LARGE", message: "Scan paling besar 15 MB." });
    expect(await kept()).toBe(2);
    expect(ocr.calls).toHaveLength(2);
    // larger than an upload through POST /api/files may be, and still a scan
    expect((await scan("IN", { bytes: Buffer.concat([JPEG_BYTES, Buffer.alloc(limit - JPEG_BYTES.length)]) })).statusCode).toBe(200);
  });

  it("is for desk staff: no partner account, no account below gate CREATE", async () => {
    const { scan, database } = await walkInApp();
    expect((await scan("IN", { as: null })).statusCode).toBe(401);
    for (const username of ["pks1", "angkut1", "qc"]) {
      const response = await scan("IN", { as: username });
      expect(response.statusCode, username).toBe(403);
    }
    expect((await scan("IN", { as: "logistics" })).statusCode).toBe(200);
    expect(await database.query("select count(*)::int as n from files")).toEqual([{ n: 1 }]);
  });

  it("logs sizes, counts and timings, never what the document says", async () => {
    const ocr = await startFakeOcr();
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString("utf8"));
        done();
      },
    });
    const { app, database } = await testApp({ OCR_API_URL: ocr.url }, { logger: { level: "info", stream } });
    await seedStaff(database, "pos", DESK);
    await seedCompany(database, "PT Sawit Satu", { supplier: true });
    const send = async () => {
      const body = multipart({ name: "surat BK 5001 EE.jpg", type: "image/jpeg", bytes: JPEG_BYTES }, { direction: "IN" });
      return app.inject({ method: "POST", url: "/api/gate/scan-document", headers: { ...(await bearer(app, "pos")), ...body.headers }, payload: body.payload });
    };
    expect((await send()).statusCode).toBe(200);
    await ocr.close();
    expect((await send()).statusCode).toBe(502);

    const log = lines.join("");
    const scanned = log
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === "document scanned");
    expect(scanned).toMatchObject({ direction: "IN", sizeBytes: JPEG_BYTES.length, fieldsFound: 12, fieldsTotal: 12, flagged: 0, unreadable: false, ocrMs: expect.any(Number), matchMs: expect.any(Number), missing: expect.any(Number) });
    expect(log).toContain('"msg":"document reading failed"');
    expect(log).toContain('"reason":"UNREACHABLE"');
    for (const secret of ["SUPIR SURAT", "SIMSURAT", "BK 5001", "0012/UJI", "0456/MS", "SAWIT SATU", "ANGKUT SATU"]) expect(log, secret).not.toContain(secret);
  });
});
