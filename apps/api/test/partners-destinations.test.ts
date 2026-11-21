import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { bearer, LOGISTICS, seedPartnerUser, seedStaff, TRANSPORTER, VIEWER } from "./helpers/users.js";

async function setup() {
  const context = await testApp();
  const { app, database } = context;
  const adminId = await seedStaff(database, "logistics", LOGISTICS);
  await seedStaff(database, "qc", VIEWER);
  const partner = async (name: string, code: string | null, flags: string, active = true) =>
    Number(
      (
        await database.query<{ id: number }>(
          "insert into partners (name, code, is_supplier, is_customer, is_transporter, is_active) values ($1, $2, $3, $4, $5, $6) returning id::int as id",
          [name, code, flags.includes("S"), flags.includes("C"), flags.includes("T"), active],
        )
      )[0]?.id,
    );
  const ids = {
    pks: await partner("PT Kebun Alpha", "V001", "S"),
    pembeli: await partner("PT Pembeli Beta", "C200", "C"),
    angkut: await partner("PT Angkut Gamma", "VCF-7", "T"),
    serba: await partner("CV Serba Delta", null, "SCT"),
    tutup: await partner("PT Tutup Epsilon", "V009", "ST", false),
  };
  await seedPartnerUser(database, "angkut", ids.angkut, TRANSPORTER);
  const call = async (method: "GET" | "POST" | "PATCH", url: string, username: string | null = "logistics", payload?: object) =>
    app.inject({ method, url, headers: username ? await bearer(app, username) : {}, ...(payload ? { payload } : {}) });
  return { ...context, adminId, ids, call };
}

describe("GET /api/partners", () => {
  it("lists active partners, by role and search word", async () => {
    const { call, ids } = await setup();
    const names = async (query: string) => (await call("GET", `/api/partners${query}`, "qc")).json().items.map((item: { name: string }) => item.name);

    const all = (await call("GET", "/api/partners")).json();
    expect(all.total).toBe(4);
    expect(all.items[0]).toEqual({ id: ids.serba, name: "CV Serba Delta", code: null, isSupplier: true, isCustomer: true, isTransporter: true });
    expect(await names("")).toEqual(["CV Serba Delta", "PT Angkut Gamma", "PT Kebun Alpha", "PT Pembeli Beta"]);
    expect(await names("?role=supplier")).toEqual(["CV Serba Delta", "PT Kebun Alpha"]);
    expect(await names("?role=customer")).toEqual(["CV Serba Delta", "PT Pembeli Beta"]);
    expect(await names("?role=transporter")).toEqual(["CV Serba Delta", "PT Angkut Gamma"]);
    expect(await names("?q=gamma")).toEqual(["PT Angkut Gamma"]);
    expect(await names("?q=vcf-")).toEqual(["PT Angkut Gamma"]);
    expect(await names("?role=supplier&q=pt")).toEqual(["PT Kebun Alpha"]);
    const limited = (await call("GET", "/api/partners?limit=1")).json();
    expect(limited.items).toHaveLength(1);
    expect(limited.total).toBe(4);
  });

  it("answers 400 for an unknown role and is closed to partner accounts", async () => {
    const { call } = await setup();
    const invalid = await call("GET", "/api/partners?role=driver");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.fields).toEqual([{ field: "role", message: "Role harus supplier, customer, atau transporter." }]);
    expect((await call("GET", "/api/partners", "angkut")).statusCode).toBe(403);
    expect((await call("GET", "/api/partners", null)).statusCode).toBe(401);
  });
});

describe("destinations", () => {
  const gudang = (partnerId?: number) => ({
    ...(partnerId === undefined ? {} : { partnerId }),
    name: " Gudang Satu ",
    address: "Jl. Pelabuhan 1",
    district: "Kecamatan A",
    regency: "Kota B",
    province: "Provinsi C",
  });

  it("creates a destination for a customer or for everyone", async () => {
    const { call, ids, database, adminId } = await setup();
    const response = await call("POST", "/api/destinations", "logistics", gudang(ids.pembeli));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      destination: {
        id: expect.any(Number),
        partner: { id: ids.pembeli, name: "PT Pembeli Beta" },
        name: "Gudang Satu",
        address: "Jl. Pelabuhan 1",
        district: "Kecamatan A",
        regency: "Kota B",
        province: "Provinsi C",
        isActive: true,
      },
    });
    expect(await database.query("select created_by::int as created_by from destinations")).toEqual([{ created_by: adminId }]);

    const generic = await call("POST", "/api/destinations", "logistics", { name: "Pelabuhan Umum", address: "Dermaga 2" });
    expect(generic.json().destination).toMatchObject({ partner: null, district: null, regency: null, province: null });
  });

  it("answers 400 VALIDATION without name or address, or for a partner that does not exist", async () => {
    const { call, database } = await setup();
    const empty = await call("POST", "/api/destinations", "logistics", { name: "  " });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.fields).toEqual([
      { field: "name", message: "Nama tempat wajib diisi." },
      { field: "address", message: "Alamat wajib diisi." },
    ]);
    const unknown = await call("POST", "/api/destinations", "logistics", { ...gudang(999999) });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.fields).toEqual([{ field: "partnerId", message: "Partner tidak ditemukan." }]);
    expect(await database.query("select count(*)::int as n from destinations")).toEqual([{ n: 0 }]);
  });

  it("changes a destination, and answers 404 for an unknown one", async () => {
    const { call, ids } = await setup();
    const id = (await call("POST", "/api/destinations", "logistics", gudang(ids.pembeli))).json().destination.id as number;
    const response = await call("PATCH", `/api/destinations/${id}`, "logistics", { name: "Gudang Dua", district: null, partnerId: null, isActive: false });
    expect(response.statusCode).toBe(200);
    expect(response.json().destination).toEqual({
      id,
      partner: null,
      name: "Gudang Dua",
      address: "Jl. Pelabuhan 1",
      district: null,
      regency: "Kota B",
      province: "Provinsi C",
      isActive: false,
    });
    expect((await call("PATCH", `/api/destinations/${id}`, "logistics", { address: "" })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/destinations/${id}`, "logistics", { partnerId: 999999 })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/destinations/999999", "logistics", { name: "x" })).statusCode).toBe(404);
  });

  it("lists destinations; partnerId gives that partner's and the ones for everyone", async () => {
    const { call, ids } = await setup();
    await call("POST", "/api/destinations", "logistics", gudang(ids.pembeli));
    await call("POST", "/api/destinations", "logistics", { partnerId: ids.serba, name: "Depo Serba", address: "Jl. Industri 9" });
    await call("POST", "/api/destinations", "logistics", { name: "Pelabuhan Umum", address: "Dermaga 2" });
    const names = async (query: string) => (await call("GET", `/api/destinations${query}`, "qc")).json().items.map((item: { name: string }) => item.name);

    expect(await names("")).toEqual(["Depo Serba", "Gudang Satu", "Pelabuhan Umum"]);
    expect(await names(`?partnerId=${ids.pembeli}`)).toEqual(["Gudang Satu", "Pelabuhan Umum"]);
    expect(await names(`?partnerId=${ids.pks}`)).toEqual(["Pelabuhan Umum"]);
    expect(await names("?q=dermaga")).toEqual(["Pelabuhan Umum"]);
    expect(await names(`?partnerId=${ids.serba}&q=depo`)).toEqual(["Depo Serba"]);
    const limited = (await call("GET", "/api/destinations?limit=2")).json();
    expect(limited.items).toHaveLength(2);
    expect(limited.total).toBe(3);
    expect((await call("GET", "/api/destinations?partnerId=x")).statusCode).toBe(400);
  });

  it("lets only system and logistics admins write, and only staff read", async () => {
    const { call, database } = await setup();
    expect((await call("POST", "/api/destinations", "qc", gudang())).statusCode).toBe(403);
    expect((await call("POST", "/api/destinations", "angkut", gudang())).statusCode).toBe(403);
    expect((await call("PATCH", "/api/destinations/1", "qc", { name: "x" })).statusCode).toBe(403);
    expect((await call("GET", "/api/destinations", "angkut")).statusCode).toBe(403);
    expect((await call("GET", "/api/destinations", null)).statusCode).toBe(401);
    expect(await database.query("select count(*)::int as n from destinations")).toEqual([{ n: 0 }]);
  });
});
