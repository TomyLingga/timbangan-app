// Tanks synced from Odoo without a matching product carry the Odoo comment as product_label. The field forms
// offer and accept such a tank when the label names the truck's product: its name or code in any case, or "CPO"
// for a product of category CPO. A tank without product and label still takes any product.
import { describe, expect, it } from "vitest";
import { labelFits } from "../src/plant-masters/tank-products.js";
import { fieldApp, type FieldApp } from "./helpers/field.js";

async function labelledTank(ctx: FieldApp, code: string, label: string | null) {
  const [row] = await ctx.database.query<{ id: number }>(
    "insert into storage_tanks (site_id, code, name, product_label, erp_ref) select id, $1, $1, $2, $3 from sites order by id limit 1 returning id",
    [code, label, `stock.location,${code}`],
  );
  return Number(row?.id);
}

async function setup() {
  const ctx = await fieldApp();
  const tanks = {
    cpoLabel: await labelledTank(ctx, "TK-L-CPO", "cpo"),
    byName: await labelledTank(ctx, "TK-L-NAME", "MINYAK CONTOH MENTAH"),
    olein: await labelledTank(ctx, "TK-L-OLN", "Minyak Contoh Olahan"),
    pfad: await labelledTank(ctx, "TK-L-PFAD", "PFAD"),
    any: await labelledTank(ctx, "TK-ANY", null),
  };
  return { ctx, tanks };
}

const codes = (form: { tanks: { code: string }[] }) => form.tanks.map((tank) => tank.code);

describe("tanks chosen by the Odoo label", () => {
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

  it("offers labelled tanks of the truck's product to incoming CPO unloading and to QC loading", async () => {
    const { ctx } = await setup();
    const incoming = await ctx.incoming();
    await ctx.forceReady(incoming.tripId, "UNLOADING");
    const unloading = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(incoming.tripId, "UNLOADING")}`, "bongkar")).json().form;
    expect(codes(unloading)).toEqual(["TK-ANY", "TK-CPO", "TK-CPO2", "TK-L-CPO", "TK-L-NAME"]);

    const outgoing = await ctx.outgoing();
    await ctx.forceReady(outgoing.tripId, "QC_LOADING");
    const qc = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(outgoing.tripId, "QC_LOADING")}`, "qcop")).json().form;
    expect(codes(qc)).toEqual(["TK-ANY", "TK-L-OLN", "TK-OLN", "TK-OLN2"]);
  });

  it("accepts a labelled tank of the truck's product on the unloading form and refuses another label", async () => {
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
    const accepted = await ctx.form(id, "unloading", body(tanks.cpoLabel), "bongkar");
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await ctx.database.query("select tank_id from handlings where trip_id = $1", [truck.tripId])).toEqual([{ tank_id: tanks.cpoLabel }]);
  });
});
