// The work list of the phones: waiting steps of trucks inside the plant, per module the account holds, one step
// with what its form needs, finding a truck by barcode, plate or card, and the seals the seal officer may use.
import { describe, expect, it } from "vitest";
import { fieldApp, type FieldApp } from "./helpers/field.js";

const list = async (ctx: FieldApp, as: string, query = "") => {
  const response = await ctx.call("GET", `/api/work/steps${query}`, as);
  expect(response.statusCode, response.body).toBe(200);
  return response.json().items as { id: number; stepCode: string; truck: { tripId: number } }[];
};
const codes = (items: { stepCode: string; truck: { tripId: number } }[]) => items.map((item) => `${item.truck.tripId}:${item.stepCode}`);
const complete = (ctx: FieldApp, tripId: number, stepCode: string) => ctx.call("POST", `/api/trips/${tripId}/steps/${stepCode}/complete`, "lapangan", { result: "PASS" });

describe("GET /api/work/steps", () => {
  it("lists the READY and IN_PROGRESS steps of trucks inside, per module the account holds, oldest ready first", async () => {
    const ctx = await fieldApp();
    const a = await ctx.incoming({ plate: "BK 1111 AA" });
    ctx.clock.advance(60_000);
    const b = await ctx.outgoing({ plate: "BK 2222 BB" });
    ctx.clock.advance(60_000);
    await ctx.weigh(ctx.wbOut.key, { cardUid: b.cardUid, weightKg: 15_000, plateRead: b.plateNo });
    ctx.clock.advance(60_000);
    const c = await ctx.incoming({ plate: "BK 3333 CC" });

    expect(codes(await list(ctx, "satpam"))).toEqual([`${a.tripId}:SEAL_CHECK`, `${c.tripId}:SEAL_CHECK`]);
    expect(codes(await list(ctx, "qcop"))).toEqual([`${b.tripId}:CLEANLINESS`]);
    // the seal check of a was ready before the cleanliness check of b
    expect(codes(await list(ctx, "lapangan"))).toEqual([`${a.tripId}:SEAL_CHECK`, `${b.tripId}:CLEANLINESS`, `${c.tripId}:SEAL_CHECK`]);
    expect(codes(await list(ctx, "lapangan", "?module=qc"))).toEqual([`${b.tripId}:CLEANLINESS`]);
    expect(codes(await list(ctx, "lapangan", "?q=bk%203333"))).toEqual([`${c.tripId}:SEAL_CHECK`]);
    expect(codes(await list(ctx, "lapangan", "?limit=1"))).toEqual([`${a.tripId}:SEAL_CHECK`]);
    // a module the account does not hold narrows to nothing; the weighbridge steps belong to no module
    expect(await list(ctx, "satpam", "?module=qc")).toEqual([]);
    await complete(ctx, a.tripId, "SEAL_CHECK");
    expect(codes(await list(ctx, "satpam"))).toEqual([`${c.tripId}:SEAL_CHECK`]);

    const [row] = await list(ctx, "qcop");
    expect(row).toEqual({
      id: await ctx.stepId(b.tripId, "CLEANLINESS"),
      stepCode: "CLEANLINESS",
      name: "Cek kebersihan dan najis",
      module: "qc",
      status: "READY",
      result: null,
      attempt: 1,
      readyAt: "2026-11-20T03:02:00.000Z",
      startedAt: null,
      truck: {
        tripId: b.tripId,
        tripNo: expect.any(String),
        plateNo: "BK2222BB",
        plateDisplay: "BK 2222 BB",
        direction: "OUT",
        flowCode: "OUT_BULK",
        product: { id: ctx.products.olein, name: "Minyak Contoh Olahan" },
        partner: { id: ctx.companies.customer1, name: "PT Pembeli Satu" },
        transporter: { id: ctx.companies.transporter1, name: "PT Angkut Satu" },
        driverName: expect.stringMatching(/^Supir Keluar /),
      },
    });
  });

  it("leaves out trucks that are no longer inside", async () => {
    const ctx = await fieldApp();
    const a = await ctx.incoming();
    await ctx.database.query("update trips set status = 'CANCELLED', cancelled_at = now() where id = $1", [a.tripId]);
    expect(await list(ctx, "satpam")).toEqual([]);
  });

  it("refuses a partner account, a staff account without any permission, and a bad module or limit", async () => {
    const ctx = await fieldApp();
    expect((await ctx.call("GET", "/api/work/steps", "pks1")).statusCode).toBe(403);
    await ctx.seed.seedStaff(ctx.database, "kosong", {});
    expect((await ctx.call("GET", "/api/work/steps", "kosong")).json().error.code).toBe("NO_ACCESS");
    expect((await ctx.call("GET", "/api/work/steps?module=QC!", "satpam")).statusCode).toBe(400);
    expect((await ctx.call("GET", "/api/work/steps?limit=0", "satpam")).statusCode).toBe(400);
  });
});

describe("GET /api/work/steps/:id", () => {
  it("gives the incoming QC form the letter figures, declared values, its parameters with spec limits, and the steps before", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming({ plate: "BK 4444 DD", contracts: [{ originNetKg: 20_000 }] });
    await ctx.database.query("insert into product_quality_specs (product_id, parameter_code, max_value, valid_from) values ($1, 'FFA', 5, '2026-01-01'), ($1, 'MOISTURE', 0.5, '2026-01-01')", [ctx.products.cpo]);
    await complete(ctx, truck.tripId, "SEAL_CHECK");
    await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: truck.plateNo });
    const id = await ctx.stepId(truck.tripId, "QC");

    const response = await ctx.call("GET", `/api/work/steps/${id}`, "qcop");
    expect(response.statusCode, response.body).toBe(200);
    const { step, form } = response.json();
    expect(step).toMatchObject({ id, stepCode: "QC", status: "READY", truck: { tripId: truck.tripId, plateDisplay: "BK 4444 DD", product: { id: ctx.products.cpo } } });
    expect(form.letter).toEqual({
      docGrossKg: 30_000,
      docTareKg: 10_000,
      docNetKg: 20_000,
      allocations: [
        expect.objectContaining({ seq: 1, spbNo: expect.stringMatching(/^SPB-/), originGrossKg: 30_000, originTareKg: 10_000, originNetKg: 20_000, quality: { FFA: 3.1 } }),
      ],
    });
    expect(form.declaredSeals).toEqual([]);
    expect(form.tanks).toEqual([]);
    expect(form.parameters).toEqual([
      { code: "FFA", name: "FFA", unit: "%", decimals: 2, minValid: 0, maxValid: 20, required: true, spec: { min: null, max: 5 } },
      { code: "MOISTURE", name: "Moisture (kadar air)", unit: "%", decimals: 3, minValid: 0, maxValid: 5, required: true, spec: { min: null, max: 0.5 } },
      { code: "IMPURITIES", name: "Impurities (kotoran)", unit: "%", decimals: 3, minValid: 0, maxValid: 5, required: false, spec: null },
    ]);
    expect(form.sealsInPlace).toEqual([]);
    expect(form.history.map((item: { stepCode: string; status: string }) => `${item.stepCode}:${item.status}`)).toEqual(["CHECK_IN:DONE", "SEAL_CHECK:DONE", "WEIGH_1:DONE"]);
    expect(form.history[2]).toMatchObject({ stepCode: "WEIGH_1", name: "Timbang 1 (bruto)", attempt: 1, result: "PASS", summary: { weightKg: 30_000, kind: "GROSS" } });
  });

  it("offers the active tanks of the truck's product to unloading and QC loading, and the QC loading parameters", async () => {
    const ctx = await fieldApp();
    await ctx.database.query("update storage_tanks set is_active = false where id = $1", [ctx.tanks.cpo2]);
    const incoming = await ctx.incoming();
    await ctx.forceReady(incoming.tripId, "UNLOADING");
    const unloading = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(incoming.tripId, "UNLOADING")}`, "bongkar")).json().form;
    expect(unloading.tanks).toEqual([{ id: ctx.tanks.cpo, code: "TK-CPO", name: "Tangki TK-CPO", label: "Minyak Contoh Mentah", fitsProduct: true }]);
    expect(unloading.parameters).toEqual([]);

    const outgoing = await ctx.outgoing();
    await ctx.forceReady(outgoing.tripId, "QC_LOADING");
    const qc = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(outgoing.tripId, "QC_LOADING")}`, "qcop")).json().form;
    expect(qc.tanks.map((tank: { code: string }) => tank.code)).toEqual(["TK-OLN", "TK-OLN2"]);
    expect(qc.letter).toBeNull();
    expect(qc.parameters.map((row: { code: string; required: boolean }) => `${row.code}${row.required ? "*" : ""}`)).toEqual([
      "FFA*", "MOISTURE", "IMPURITIES",
    ]);
    // a parameter switched on joins the form in its place
    await ctx.database.query("update quality_parameters set is_active = true where code = 'MNI'");
    const again = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(outgoing.tripId, "QC_LOADING")}`, "qcop")).json().form;
    expect(again.parameters.map((row: { code: string }) => row.code)).toEqual(["FFA", "MOISTURE", "IMPURITIES", "MNI"]);
  });

  it("answers 404 for a step outside the account's modules and for an unknown step", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming();
    const id = await ctx.stepId(truck.tripId, "SEAL_CHECK");
    expect((await ctx.call("GET", `/api/work/steps/${id}`, "satpam")).statusCode).toBe(200);
    expect((await ctx.call("GET", `/api/work/steps/${id}`, "qclihat")).statusCode).toBe(200);
    expect((await ctx.call("GET", `/api/work/steps/${id}`, "qcop")).statusCode).toBe(404);
    // the weighing step belongs to no module
    expect((await ctx.call("GET", `/api/work/steps/${await ctx.stepId(truck.tripId, "WEIGH_1")}`, "lapangan")).statusCode).toBe(404);
    expect((await ctx.call("GET", "/api/work/steps/999999", "satpam")).statusCode).toBe(404);
    expect((await ctx.call("GET", `/api/work/steps/${id}`, "pks1")).statusCode).toBe(403);
  });
});

describe("GET /api/work/find", () => {
  it("finds a truck inside by its SPJ barcode, its plate or its card, with the ready steps the account may see", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming({ plate: "BK 5555 EE" });
    const [spj] = await ctx.database.query<{ barcode_token: string }>("select barcode_token from spj_documents where trip_id = $1", [truck.tripId]);
    const find = (query: string, as = "satpam") => ctx.call("GET", `/api/work/find?${query}`, as);

    const byBarcode = await find(`barcode=${spj?.barcode_token.toLowerCase()}`);
    expect(byBarcode.statusCode, byBarcode.body).toBe(200);
    expect(byBarcode.json()).toEqual({
      truck: expect.objectContaining({ tripId: truck.tripId, plateNo: "BK5555EE", plateDisplay: "BK 5555 EE", direction: "IN" }),
      steps: [expect.objectContaining({ id: await ctx.stepId(truck.tripId, "SEAL_CHECK"), stepCode: "SEAL_CHECK", status: "READY" })],
    });
    expect((await find("plate=bk%205555%20ee")).json().truck.tripId).toBe(truck.tripId);
    expect((await find(`cardUid=${truck.cardUid.toLowerCase()}`)).json().truck.tripId).toBe(truck.tripId);
    // found, but nothing for this account to do
    expect((await find("plate=BK5555EE", "qcop")).json().steps).toEqual([]);

    expect((await find("plate=BK5555")).statusCode).toBe(404);
    expect((await find("barcode=ZZZZZZZZZZZZ")).statusCode).toBe(404);
    const both = await find(`plate=BK5555EE&cardUid=${truck.cardUid}`);
    expect(both.statusCode).toBe(400);
    expect(both.json().error.fields).toEqual([{ field: "query", message: "Isi tepat satu: barcode, plate, atau cardUid." }]);
    expect((await find("")).statusCode).toBe(400);
    expect((await find("plate=BK5555EE", "pks1")).statusCode).toBe(403);

    await ctx.database.query("update trips set status = 'CANCELLED', cancelled_at = now() where id = $1", [truck.tripId]);
    expect((await find("plate=BK5555EE")).statusCode).toBe(404);
  });
});

describe("GET /api/work/seals/available", () => {
  it("lists the available stock seals for holders of sealing at create level", async () => {
    const ctx = await fieldApp();
    await ctx.database.query("update seals set status = 'VOID' where id = $1", [ctx.seals[0]]);
    await ctx.database.query("insert into seals (site_id, seal_no, kind) select id, 'BC-0001', 'CUSTOMS' from sites");
    const listed = await ctx.call("GET", "/api/work/seals/available?kind=LOCIS&limit=3", "segel");
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items).toEqual([
      { id: ctx.seals[1], sealNo: "LC-0002", kind: "LOCIS" },
      { id: ctx.seals[2], sealNo: "LC-0003", kind: "LOCIS" },
      { id: ctx.seals[3], sealNo: "LC-0004", kind: "LOCIS" },
    ]);
    expect((await ctx.call("GET", "/api/work/seals/available?kind=CUSTOMS", "segel")).json().items).toEqual([expect.objectContaining({ sealNo: "BC-0001" })]);
    expect((await ctx.call("GET", "/api/work/seals/available?q=0020", "segel")).json().items).toEqual([expect.objectContaining({ sealNo: "LC-0020" })]);
    expect((await ctx.call("GET", "/api/work/seals/available", "qclihat")).statusCode).toBe(403);
  });
});
