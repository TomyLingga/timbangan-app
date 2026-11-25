// Files on delivery orders (the DO letter logistics sends to the transporter) and weighbridge slips per truck of an
// incoming registration (the supplier's own scale). Who may upload, link, remove and read each file.
import { describe, expect, it } from "vitest";
import { DESTINATION, phase3App, seedContract, seedDestination, seedDriver, seedVehicle, sendShipmentRequest } from "./helpers/fixtures.js";
import { multipart, PNG_BYTES } from "./helpers/field.js";
import { bearer, seedStaff } from "./helpers/users.js";

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x20), Buffer.from("\n%%EOF\n")]);

async function setup() {
  const ctx = await phase3App();
  const { app, database, companies, products } = ctx;
  await seedStaff(database, "penjaga", { registrations: "EDIT", gate: "VIEW" });
  await seedStaff(database, "pembuat", { registrations: "CREATE" });
  await seedStaff(database, "kantordo", { delivery_orders: "CREATE" });
  await seedStaff(database, "lihatdo", { delivery_orders: "VIEW" });
  const headers = new Map<string, { authorization: string }>();
  const as = async (username: string) => {
    if (!headers.has(username)) headers.set(username, await bearer(app, username));
    return headers.get(username) as { authorization: string };
  };
  const request = async (method: "GET" | "POST" | "DELETE", url: string, username: string, payload?: object) =>
    app.inject({ method, url, headers: await as(username), ...(payload ? { payload } : {}) });
  const upload = async (username: string, file: Parameters<typeof multipart>[0] = { bytes: PNG_BYTES }) => {
    const body = multipart(file);
    return app.inject({ method: "POST", url: "/api/files", headers: { ...(await as(username)), ...body.headers }, payload: body.payload });
  };
  const uploadOk = async (username: string, file?: Parameters<typeof multipart>[0]) => {
    const response = await upload(username, file);
    if (response.statusCode !== 201) throw new Error(response.body);
    return (response.json() as { id: number }).id;
  };
  const read = async (id: number, username: string) => app.inject({ method: "GET", url: `/api/files/${id}`, headers: await as(username) });

  const sale = await seedContract(database, { no: "SC-901/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, qty: 500_000 });
  const place = await seedDestination(database, "Gudang Contoh");
  const newDo = async () => {
    const response = await ctx.call("POST", "/api/delivery-orders", "logistics", {
      contractId: sale, doDate: "2026-11-20", qty: 60_000, ...DESTINATION, deliveryFrom: "2026-11-20", transporterId: companies.transporter1,
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    return (response.json() as { deliveryOrder: { id: number } }).deliveryOrder.id;
  };

  const purchase = await seedContract(database, { no: "PC-901/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: 100_000 });
  await sendShipmentRequest(database, purchase);
  const vehicle = await seedVehicle(database, { plate: "BK 9101 AA" });
  const driver = await seedDriver(database, { name: "Supir Contoh", licence: "SIM0009101" });
  const draft = async (submit = false) => {
    const response = await ctx.call("POST", "/api/registrations", "pks1", {
      direction: "IN", submit, plannedDate: "2026-11-21", allocations: [{ contractId: purchase }], trips: [{ vehicle: { id: vehicle }, driver: { id: driver } }],
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    const registration = response.json().registration as { id: number; status: string; trips: { id: number }[] };
    return { id: registration.id, tripId: Number(registration.trips[0]?.id), status: registration.status };
  };
  return { ...ctx, request, upload, uploadOk, read, newDo, draft };
}

describe("POST /api/files", () => {
  it("takes a PDF up to 10 MB from staff and partners, and keeps images at 5 MB", async () => {
    const { upload, database } = await setup();
    const pdf = await upload("pks1", { name: "slip.pdf", type: "application/pdf", bytes: PDF_BYTES });
    expect(pdf.statusCode, pdf.body).toBe(201);
    expect(pdf.json()).toEqual({ id: expect.any(Number), originalName: "slip.pdf", mimeType: "application/pdf", sizeBytes: PDF_BYTES.length });
    const image = await upload("pks1", { name: "slip.png", bytes: PNG_BYTES });
    expect(image.statusCode).toBe(201);
    const staffImage = await upload("kantordo", { bytes: PNG_BYTES });
    expect(await database.query("select mime_type, kind, storage_key like '%.pdf' as pdf from files order by id")).toEqual([
      { mime_type: "application/pdf", kind: "PDF", pdf: true },
      // a partner's picture is a scan of a paper, never a field photo
      { mime_type: "image/png", kind: "SCAN", pdf: false },
      { mime_type: "image/png", kind: "PHOTO", pdf: false },
    ]);
    expect(staffImage.statusCode).toBe(201);

    const bigPdf = await upload("kantordo", { name: "besar.pdf", type: "application/pdf", bytes: Buffer.concat([PDF_BYTES, Buffer.alloc(10 * 1024 * 1024)]) });
    expect(bigPdf.statusCode).toBe(413);
    expect(bigPdf.json().error).toEqual({ code: "FILE_TOO_LARGE", message: "Berkas paling besar 10 MB, gambar paling besar 5 MB." });
    const fullPdf = await upload("kantordo", { name: "pas.pdf", type: "application/pdf", bytes: Buffer.concat([PDF_BYTES, Buffer.alloc(10 * 1024 * 1024 - PDF_BYTES.length)]) });
    expect(fullPdf.statusCode).toBe(201);
    const bigImage = await upload("kantordo", { bytes: Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]) });
    expect(bigImage.statusCode).toBe(413);
    expect(bigImage.json().error.code).toBe("FILE_TOO_LARGE");
    const html = await upload("pks1", { name: "slip.pdf", type: "application/pdf", bytes: Buffer.from("<html>%PDF-</html>") });
    expect(html.statusCode).toBe(400);
    expect(html.json().error.fields).toEqual([{ field: "file", message: "Berkas harus PDF atau gambar JPEG, PNG, atau WebP." }]);
  });

  it("needs registrations:CREATE from a partner account", async () => {
    const { upload, database, ids } = await setup();
    await database.query("delete from user_permissions where user_id = $1 and module_code = 'registrations'", [ids.pks1]);
    const refused = await upload("pks1");
    expect(refused.statusCode).toBe(403);
  });
});

describe("GET /api/files/:id", () => {
  it("serves a PDF inline with its name, and lets a partner read only its own company's uploads", async () => {
    const { uploadOk, read, seed, database, companies } = await setup();
    await seed.seedPartnerUser(database, "pks1b", companies.supplier1);
    const id = await uploadOk("pks1", { name: "slip timbang (1).pdf", type: "application/pdf", bytes: PDF_BYTES });
    const own = await read(id, "pks1");
    expect(own.statusCode).toBe(200);
    expect(own.headers["content-type"]).toBe("application/pdf");
    expect(own.headers["content-disposition"]).toBe("inline; filename=\"slip timbang (1).pdf\"; filename*=UTF-8''slip%20timbang%20%281%29.pdf");
    expect(own.rawPayload).toEqual(PDF_BYTES);
    expect((await read(id, "pks1b")).statusCode).toBe(200);
    expect((await read(id, "logistics")).statusCode).toBe(200);
    // another company cannot tell the file exists
    const other = await read(id, "pks2");
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe("NOT_FOUND");
    expect((await read(id, "angkut1")).statusCode).toBe(404);
  });
});

describe("files of a delivery order", () => {
  it("are added by logistics while the DO is a draft or sent, listed on the DO, and read by its transporter", async () => {
    const { request, uploadOk, read, newDo, ctxDo = await newDo() } = await setup().then(async (ctx) => ({ ...ctx, ctxDo: undefined as number | undefined }));
    const letter = await uploadOk("logistics", { name: "surat-do.pdf", type: "application/pdf", bytes: PDF_BYTES });
    const added = await request("POST", `/api/delivery-orders/${ctxDo}/files`, "kantordo", { fileId: letter, label: "Surat DO" });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().files).toEqual([
      {
        id: letter, label: "Surat DO", originalName: "surat-do.pdf", mimeType: "application/pdf", sizeBytes: PDF_BYTES.length,
        addedAt: "2026-11-20T03:00:00.000Z", addedBy: { id: expect.any(Number), fullName: "Staff kantordo" },
      },
    ]);
    // a draft is not shown to the transporter, nor its letter
    expect((await read(letter, "angkut1")).statusCode).toBe(404);
    expect((await request("POST", `/api/delivery-orders/${ctxDo}/send`, "logistics", {})).statusCode).toBe(200);

    const detail = await request("GET", `/api/delivery-orders/${ctxDo}`, "angkut1");
    expect(detail.json().files.map((file: { id: number }) => file.id)).toEqual([letter]);
    expect((await read(letter, "angkut1")).statusCode).toBe(200);
    expect((await read(letter, "angkut2")).statusCode).toBe(404);
    expect((await read(letter, "pks1")).statusCode).toBe(404);

    // still allowed while SENT; not once accepted
    const second = await uploadOk("logistics");
    expect((await request("POST", `/api/delivery-orders/${ctxDo}/files`, "kantordo", { fileId: second })).statusCode).toBe(201);
    expect((await request("POST", `/api/delivery-orders/${ctxDo}/accept`, "angkut1", {})).statusCode).toBe(200);
    const late = await request("POST", `/api/delivery-orders/${ctxDo}/files`, "kantordo", { fileId: await uploadOk("logistics") });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toEqual({ code: "INVALID_STATE", message: "Lampiran DO hanya bisa diubah selama DO berstatus DRAFT atau SENT." });
    expect((await request("DELETE", `/api/delivery-orders/${ctxDo}/files/${second}`, "kantordo")).statusCode).toBe(409);
  });

  it("removes a file from a draft, keeps 5 at most, refuses a partner's file, a file twice, and other accounts", async () => {
    const { request, uploadOk, newDo, database } = await setup();
    const id = await newDo();
    const ids: number[] = [];
    for (let n = 0; n < 5; n++) {
      ids.push(await uploadOk("logistics"));
      expect((await request("POST", `/api/delivery-orders/${id}/files`, "kantordo", { fileId: ids[n] })).statusCode).toBe(201);
    }
    const sixth = await request("POST", `/api/delivery-orders/${id}/files`, "kantordo", { fileId: await uploadOk("logistics") });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error).toEqual({ code: "TOO_MANY_FILES", message: "Paling banyak 5 lampiran per DO." });
    const twice = await request("POST", `/api/delivery-orders/${id}/files`, "kantordo", { fileId: ids[0] });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("DUPLICATE");

    const removed = await request("DELETE", `/api/delivery-orders/${id}/files/${ids[0]}`, "kantordo");
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().files.map((file: { id: number }) => file.id)).toEqual(ids.slice(1));
    expect((await request("DELETE", `/api/delivery-orders/${id}/files/${ids[0]}`, "kantordo")).statusCode).toBe(404);
    // the file itself is kept
    expect(await database.query("select count(*)::int as n from files where id = $1", [ids[0]])).toEqual([{ n: 1 }]);

    const partnerFile = await uploadOk("pks1");
    const foreign = await request("POST", `/api/delivery-orders/${id}/files`, "kantordo", { fileId: partnerFile });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.fields).toEqual([{ field: "fileId", message: "Berkas tidak ditemukan." }]);
    expect((await request("POST", `/api/delivery-orders/${id}/files`, "kantordo", { fileId: 999_999 })).statusCode).toBe(400);
    expect((await request("POST", `/api/delivery-orders/${id}/files`, "lihatdo", { fileId: ids[1] })).statusCode).toBe(403);
    expect((await request("POST", `/api/delivery-orders/${id}/files`, "angkut1", { fileId: ids[1] })).statusCode).toBe(403);
    expect((await request("POST", "/api/delivery-orders/999999/files", "kantordo", { fileId: ids[1] })).statusCode).toBe(404);
  });
});

describe("weighbridge slips of a truck", () => {
  it("are attached by the supplier to its draft, kept when the draft is saved again, and shown to the plant", async () => {
    const ctx = await setup();
    const { request, uploadOk, read, draft } = ctx;
    const registration = await draft();
    const slip = await uploadOk("pks1", { name: "slip-pks.pdf", type: "application/pdf", bytes: PDF_BYTES });
    const url = `/api/registrations/${registration.id}/trips/${registration.tripId}/files`;
    const added = await request("POST", url, "pks1", { fileId: slip });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().files).toEqual([
      { id: slip, label: "SLIP_TIMBANG", originalName: "slip-pks.pdf", mimeType: "application/pdf", sizeBytes: PDF_BYTES.length, addedAt: "2026-11-20T03:00:00.000Z", addedBy: { id: expect.any(Number), fullName: "Partner pks1" } },
    ]);

    // the draft is written again: its truck is a new row, the slip follows it
    const detail = (await request("GET", `/api/registrations/${registration.id}`, "pks1")).json().registration;
    const again = await ctx.call("PUT", `/api/registrations/${registration.id}`, "pks1", {
      direction: "IN", submit: true, plannedDate: "2026-11-21", allocations: [{ contractId: detail.allocations[0].contract.id }],
      trips: [{ vehicle: { id: detail.trips[0].vehicle.id }, driver: { id: detail.trips[0].driver.id } }],
    });
    expect(again.statusCode, again.body).toBe(200);
    const trip = again.json().registration.trips[0];
    expect(trip.slips.map((file: { id: number }) => file.id)).toEqual([slip]);

    // staff see it, also at the gate through the SPJ
    expect((await read(slip, "penjaga")).statusCode).toBe(200);
    const gate = await request("GET", `/api/gate/spj/${trip.spj.barcodeToken}`, "pos");
    expect(gate.json().trip.slips.map((file: { id: number }) => file.id)).toEqual([slip]);
    expect((await read(slip, "pks2")).statusCode).toBe(404);

    // the registration is no longer a draft: the supplier cannot change the slips, staff with EDIT can
    const late = await request("POST", `/api/registrations/${registration.id}/trips/${trip.id}/files`, "pks1", { fileId: await uploadOk("pks1") });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toEqual({ code: "INVALID_STATE", message: "Slip timbang hanya bisa diubah selama registrasi masih draf." });
    const staffSlip = await uploadOk("penjaga", { name: "slip-pos.pdf", type: "application/pdf", bytes: PDF_BYTES });
    expect((await request("POST", `/api/registrations/${registration.id}/trips/${trip.id}/files`, "penjaga", { fileId: staffSlip })).statusCode).toBe(201);
    // a staff upload linked to the supplier's registration is readable by the supplier
    expect((await read(staffSlip, "pks1")).statusCode).toBe(200);
    expect((await request("DELETE", `/api/registrations/${registration.id}/trips/${trip.id}/files/${slip}`, "penjaga")).statusCode).toBe(200);
    expect((await request("POST", `/api/registrations/${registration.id}/trips/${trip.id}/files`, "pembuat", { fileId: staffSlip })).statusCode).toBe(403);
  });

  it("keeps 3 per truck, only for the owner's own files and trucks, and only on incoming registrations", async () => {
    const ctx = await setup();
    const { request, uploadOk, draft, database } = ctx;
    const registration = await draft();
    const url = `/api/registrations/${registration.id}/trips/${registration.tripId}/files`;
    const slips = [await uploadOk("pks1"), await uploadOk("pks1"), await uploadOk("pks1")];
    for (const fileId of slips) expect((await request("POST", url, "pks1", { fileId })).statusCode).toBe(201);
    const fourth = await request("POST", url, "pks1", { fileId: await uploadOk("pks1") });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toEqual({ code: "TOO_MANY_FILES", message: "Paling banyak 3 slip timbang per truk." });
    const removed = await request("DELETE", `${url}/${slips[2]}`, "pks1");
    expect(removed.json().files.map((file: { id: number }) => file.id)).toEqual(slips.slice(0, 2));

    // another supplier: neither the registration nor its own file on it
    expect((await request("POST", url, "pks2", { fileId: await uploadOk("pks2") })).statusCode).toBe(404);
    const foreign = await request("POST", url, "pks1", { fileId: await uploadOk("pks2") });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.fields).toEqual([{ field: "fileId", message: "Berkas tidak ditemukan." }]);
    // a file already used elsewhere
    const used = await request("POST", url, "pks1", { fileId: slips[0] });
    expect(used.statusCode).toBe(409);
    expect((await request("POST", `/api/registrations/${registration.id}/trips/999999/files`, "pks1", { fileId: slips[2] })).statusCode).toBe(404);
    // a field photo is not a slip and cannot be removed here
    const photo = await uploadOk("penjaga");
    await database.query("insert into trip_files (trip_id, file_id, step_code, label) values ($1, $2, 'QC', 'photo')", [registration.tripId, photo]);
    expect((await request("DELETE", `${url}/${photo}`, "penjaga")).statusCode).toBe(404);
    expect((await request("GET", `/api/registrations/${registration.id}`, "pks1")).json().registration.trips[0].slips).toHaveLength(2);
    // the field photo stays staff-only
    expect((await ctx.read(photo, "pks1")).statusCode).toBe(404);

    const outgoing = await database.query<{ id: number }>("update registrations set direction = 'OUT', flow_code = 'OUT_BULK' where id = $1 returning id", [registration.id]);
    expect(outgoing).toHaveLength(1);
    const wrongWay = await request("POST", url, "penjaga", { fileId: await uploadOk("penjaga") });
    expect(wrongWay.statusCode).toBe(409);
    expect(wrongWay.json().error.message).toBe("Slip timbang hanya untuk registrasi incoming.");
  });
});
