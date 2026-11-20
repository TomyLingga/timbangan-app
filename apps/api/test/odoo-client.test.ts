import { describe, expect, it } from "vitest";
import { OdooClient, OdooError } from "../src/odoo/client.js";
import { datePart, many2one, numberOrNull, textOrNull } from "../src/odoo/values.js";
import { ODOO_ENV, startFakeOdoo } from "./helpers/fake-odoo.js";

const clientFor = (url: string, pageSize?: number) =>
  new OdooClient({ url, db: ODOO_ENV.ODOO_DB, uid: Number(ODOO_ENV.ODOO_UID), password: ODOO_ENV.ODOO_PASSWORD }, pageSize);

describe("OdooClient.searchRead", () => {
  it("sends exactly the JSON-RPC body Odoo 13 expects", async () => {
    const odoo = await startFakeOdoo({ "res.partner": [{ id: 3, name: "PKS A", ref: "V001" }] });
    const rows = await clientFor(odoo.url).searchRead("res.partner", [["id", "in", [3]]], ["name", "ref"]);

    expect(rows).toEqual([{ id: 3, name: "PKS A", ref: "V001" }]);
    expect(odoo.calls).toHaveLength(1);
    expect(odoo.calls[0]?.body).toEqual({
      jsonrpc: "2.0",
      method: "call",
      id: 1,
      params: {
        service: "object",
        method: "execute_kw",
        args: ["live_test", 7, "odoo-secret", "res.partner", "search_read", [[["id", "in", [3]]]], { fields: ["name", "ref"], limit: 500, offset: 0, order: "id" }],
      },
    });
  });

  it("reads page after page until a page is not full", async () => {
    const odoo = await startFakeOdoo({ "res.partner": [1, 2, 3, 4, 5].map((id) => ({ id, name: `P${id}` })) });
    const rows = await clientFor(odoo.url, 2).searchRead("res.partner", [], ["name"]);

    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(odoo.calls.map((call) => [call.options.limit, call.options.offset])).toEqual([
      [2, 0],
      [2, 2],
      [2, 4],
    ]);
  });

  it("asks once more when the last page was exactly full", async () => {
    const odoo = await startFakeOdoo({ "res.partner": [1, 2, 3, 4].map((id) => ({ id, name: `P${id}` })) });
    expect(await clientFor(odoo.url, 2).searchRead("res.partner", [], ["name"])).toHaveLength(4);
    expect(odoo.calls.map((call) => call.options.offset)).toEqual([0, 2, 4]);
  });

  it("turns an Odoo error answer into an OdooError with the server's message", async () => {
    const odoo = await startFakeOdoo();
    odoo.failWith("relation \"purchase_requisition\" does not exist");
    const attempt = clientFor(odoo.url).searchRead("purchase.requisition", [], ["name"]);
    await expect(attempt).rejects.toThrow(OdooError);
    await expect(attempt).rejects.toThrow('relation "purchase_requisition" does not exist');
  });

  it("reports an unreachable server and a non-JSON-RPC answer without leaking the password", async () => {
    const odoo = await startFakeOdoo();
    const wrongPath = new OdooClient({ url: `${odoo.url}/missing`, db: "live_test", uid: 7, password: "odoo-secret" });
    await expect(wrongPath.searchRead("res.partner", [], ["name"])).rejects.toThrow(/HTTP 404/);

    await odoo.close();
    const attempt = clientFor(odoo.url).searchRead("res.partner", [], ["name"]);
    await expect(attempt).rejects.toThrow(OdooError);
    await expect(attempt).rejects.toThrow(/cannot be reached/);
    await expect(attempt).rejects.not.toThrow(/odoo-secret/);
  });
});

describe("Odoo values", () => {
  it("reads false as an empty value", async () => {
    const odoo = await startFakeOdoo({
      "res.partner": [
        { id: 1, name: "PKS A", ref: false, street: false, parent_id: false, credit_limit: false, date: false },
        { id: 2, name: "PKS B", ref: "V002", street: "Jl. Raya 1", parent_id: [1, "PKS A"], credit_limit: 0, date: "2026-11-30 17:00:00" },
      ],
    });
    const [empty, filled] = await clientFor(odoo.url).searchRead("res.partner", [], ["name", "ref", "street", "parent_id", "credit_limit", "date"]);

    expect([textOrNull(empty?.ref), textOrNull(empty?.street), many2one(empty?.parent_id), numberOrNull(empty?.credit_limit), datePart(empty?.date)]).toEqual([null, null, null, null, null]);
    expect(textOrNull(filled?.ref)).toBe("V002");
    expect(many2one(filled?.parent_id)).toEqual({ id: 1, name: "PKS A" });
    // zero is a value, not "empty"
    expect(numberOrNull(filled?.credit_limit)).toBe(0);
    expect(datePart(filled?.date)).toBe("2026-11-30");
    expect(datePart("2026-11-01")).toBe("2026-11-01");
    expect(textOrNull("  ")).toBeNull();
  });
});
