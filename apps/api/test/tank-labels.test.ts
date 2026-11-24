// Which tanks the field forms offer and accept, following the old system: incoming CPO goes into CPO tanks (product of
// category CPO, or the Odoo label "CPO"); outgoing goods may be loaded from any active tank that is not a CPO tank
// and says what it holds (a product or a label), with the tanks of the truck's product first. A tank without product
// and label is never offered nor accepted. Tanks made in this application (no erp_ref) keep the strict rule: their
// own product only. Tank codes and labels here are made up.
import { describe, expect, it } from "vitest";
import { labelFits, labelNamesProduct } from "../src/plant-masters/tank-products.js";
import { fieldApp, type FieldApp } from "./helpers/field.js";

async function odooTank(ctx: FieldApp, code: string, label: string | null, options: { productId?: number; active?: boolean } = {}) {
  const [row] = await ctx.database.query<{ id: number }>(
    "insert into storage_tanks (site_id, code, name, product_label, product_id, is_active, erp_ref) select id, $1, $1, $2, $3, $4, $5 from sites order by id limit 1 returning id",
    [code, label, options.productId ?? null, options.active ?? true, `stock.location,${code}`],
  );
  return Number(row?.id);
}

async function setup() {
  const ctx = await fieldApp();
  const tanks = {
    cpoLabel: await odooTank(ctx, "TK-L-CPO", "cpo"),
    cpoProduct: await odooTank(ctx, "TK-S-CPO", null, { productId: ctx.products.cpo }),
    olahan: await odooTank(ctx, "TK-L-OLN", "Olahan"),
    contohOlahan: await odooTank(ctx, "TK-L-OLN2", "contoh olahan"),
    olah: await odooTank(ctx, "TK-L-OLAH", "Olah"),
    pfad: await odooTank(ctx, "TK-L-PFAD", "PFAD"),
    pfadOff: await odooTank(ctx, "TK-L-OFF", "PFAD", { active: false }),
    unlabelled: await odooTank(ctx, "TK-NOLABEL", null),
    blank: await odooTank(ctx, "TK-BLANK", "  "),
  };
  return { ctx, tanks };
}

type Choice = { code: string; label: string | null; fitsProduct: boolean };
const codes = (form: { tanks: Choice[] }) => form.tanks.map((tank) => tank.code);

describe("tank labels", () => {
  it("matches name and code in any case, and CPO to a product of category CPO", () => {
    const crude = { name: "Minyak Contoh Mentah", code: null, category: "CPO" };
    expect(labelFits("CPO", crude)).toBe(true);
    expect(labelFits(" cpo ", crude)).toBe(true);
    expect(labelFits("minyak contoh mentah", crude)).toBe(true);
    expect(labelFits("Olein", crude)).toBe(false);
    expect(labelFits("olein", { name: "RBD Palm Olein", code: "OLEIN", category: "BULK_LIQUID" })).toBe(true);
    expect(labelFits("CPO", { name: "RBD Palm Olein", code: "OLN", category: "BULK_LIQUID" })).toBe(false);
    expect(labelFits("", crude)).toBe(false);
  });

  it("names a product when the label is a whole word or words of its name or code", () => {
    const olein = { name: "Contoh Palm Olein IV56", code: "OLN-56", category: "BULK_LIQUID" };
    expect(labelNamesProduct("Olein", olein)).toBe(true);
    expect(labelNamesProduct("OLEIN IV56", olein)).toBe(true);
    expect(labelNamesProduct("oln-56", olein)).toBe(true);
    expect(labelNamesProduct("Ole", olein)).toBe(false);
    expect(labelNamesProduct("IV5", olein)).toBe(false);
    expect(labelNamesProduct(" ", olein)).toBe(false);
  });
});

describe("tank choices of the field forms", () => {
  it("offers CPO tanks to incoming CPO unloading, and never a tank without product and label", async () => {
    const { ctx } = await setup();
    const incoming = await ctx.incoming();
    await ctx.forceReady(incoming.tripId, "UNLOADING");
    const unloading = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(incoming.tripId, "UNLOADING")}`, "bongkar")).json().form;
    expect(codes(unloading)).toEqual(["TK-CPO", "TK-CPO2", "TK-L-CPO", "TK-S-CPO"]);
    expect(unloading.tanks.find((tank: Choice) => tank.code === "TK-L-CPO")).toMatchObject({ label: "cpo", fitsProduct: true });
    expect(unloading.tanks.find((tank: Choice) => tank.code === "TK-S-CPO")).toMatchObject({ label: "Minyak Contoh Mentah", fitsProduct: true });
  });

  it("offers every labelled active tank that is not CPO to QC loading, those of the truck's product first", async () => {
    const { ctx } = await setup();
    const outgoing = await ctx.outgoing();
    await ctx.forceReady(outgoing.tripId, "QC_LOADING");
    const qc = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(outgoing.tripId, "QC_LOADING")}`, "qcop")).json().form;
    expect(codes(qc)).toEqual(["TK-L-OLN", "TK-L-OLN2", "TK-OLN", "TK-OLN2", "TK-L-OLAH", "TK-L-PFAD"]);
    expect(qc.tanks.map((tank: Choice) => [tank.label, tank.fitsProduct])).toEqual([
      ["Olahan", true],
      ["contoh olahan", true],
      ["Minyak Contoh Olahan", true],
      ["Minyak Contoh Olahan", true],
      ["Olah", false],
      ["PFAD", false],
    ]);
  });

  it("accepts on QC loading the tanks it offers, and refuses CPO tanks and tanks without product and label", async () => {
    const { ctx, tanks } = await setup();
    const truck = await ctx.outgoing();
    await ctx.forceReady(truck.tripId, "QC_LOADING");
    const id = await ctx.stepId(truck.tripId, "QC_LOADING");
    const send = (extra: Record<string, unknown>) =>
      ctx.form(id, "qc-loading", { values: { FFA: 0.05, MOISTURE: 0.1, IMPURITIES: 0.02 }, tankId: tanks.pfad, ...extra }, "qcop");
    const fields = async (extra: Record<string, unknown>) => (await send(extra)).json().error.fields;
    expect(await fields({ tankId: tanks.cpoLabel })).toEqual([{ field: "tankId", message: "Tangki ini bukan untuk produk truk ini." }]);
    expect(await fields({ blendTankId: tanks.cpoProduct })).toEqual([{ field: "blendTankId", message: "Tangki ini bukan untuk produk truk ini." }]);
    expect(await fields({ tankId: tanks.unlabelled })).toEqual([{ field: "tankId", message: "Tangki ini belum punya produk atau label, jadi tidak bisa dipilih." }]);
    expect(await fields({ tankId: tanks.blank })).toEqual([{ field: "tankId", message: "Tangki ini belum punya produk atau label, jadi tidak bisa dipilih." }]);
    expect(await fields({ tankId: tanks.pfadOff })).toEqual([{ field: "tankId", message: "Tangki tidak ditemukan atau tidak aktif." }]);
    const accepted = await send({ blendTankId: tanks.olahan });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await ctx.database.query("select tank_id from handlings where trip_id = $1 order by id", [truck.tripId])).toEqual([{ tank_id: tanks.pfad }, { tank_id: tanks.olahan }]);
  });

  it("accepts a CPO tank on the unloading form and refuses other tanks", async () => {
    const { ctx, tanks } = await setup();
    const truck = await ctx.incoming();
    expect((await ctx.call("POST", `/api/trips/${truck.tripId}/steps/SEAL_CHECK/complete`, "lapangan", { result: "PASS" })).statusCode).toBe(200);
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: truck.plateNo })).json().result).toBe("SAVED");
    await ctx.forceReady(truck.tripId, "UNLOADING");
    const id = await ctx.stepId(truck.tripId, "UNLOADING");
    const body = (tankId: number) => ({
      tankId, doorNo: 1, wood: false, wire: false, plastic: false, handbrakeOn: true, engineOn: false, manholeOpen: true, dischargeValveActive: true, tankEmpty: true,
    });
    const refused = await ctx.form(id, "unloading", body(tanks.pfad), "bongkar");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.fields).toEqual([{ field: "tankId", message: "Tangki ini bukan untuk produk truk ini." }]);
    expect((await ctx.form(id, "unloading", body(tanks.unlabelled), "bongkar")).json().error.fields).toEqual([
      { field: "tankId", message: "Tangki ini belum punya produk atau label, jadi tidak bisa dipilih." },
    ]);
    const accepted = await ctx.form(id, "unloading", body(tanks.cpoLabel), "bongkar");
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await ctx.database.query("select tank_id from handlings where trip_id = $1", [truck.tripId])).toEqual([{ tank_id: tanks.cpoLabel }]);
  });

  it("lists every tank on the master page and marks the ones the forms never use", async () => {
    const { ctx, tanks } = await setup();
    const items = (await ctx.call("GET", "/api/tanks?limit=50", "pabriklihat")).json().items as { id: number; code: string; usableInForms: boolean }[];
    expect(items).toHaveLength(13);
    expect(items.filter((tank) => !tank.usableInForms).map((tank) => tank.id).sort()).toEqual([tanks.unlabelled, tanks.blank].sort());
  });
});
