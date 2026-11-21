import { describe, expect, it } from "vitest";
import { VcfAuthError, VcfClient, VcfError, VcfLoginError, vcfClientFor } from "../src/vcf/client.js";
import { FAKE_ACCOUNT, registryDriver, startFakeVcf } from "./helpers/fake-vcf.js";

const newDriver = { nama_supir: "Eko Prasetyo", no_sim: "JK12345678", jenis_sim: "B2 UMUM", tgl_berlaku_sim: "2029-02-28", is_active: true };

describe("VcfClient: writing", () => {
  it("logs in with a JSON body of username and password and keeps the token", async () => {
    const vcf = await startFakeVcf();
    const client = new VcfClient(vcf.url, FAKE_ACCOUNT);
    expect(client.canPush).toBe(true);
    await client.login();
    expect(vcf.calls).toEqual([
      {
        method: "POST",
        url: "/api/login",
        authorization: null,
        contentType: "application/json",
        accept: "application/json",
        body: { username: FAKE_ACCOUNT.username, password: FAKE_ACCOUNT.password },
      },
    ]);
  });

  it("creates a driver with the bearer token of the login, logging in once for several calls", async () => {
    const vcf = await startFakeVcf();
    const client = new VcfClient(vcf.url, FAKE_ACCOUNT);
    const first = await client.createDriver(newDriver);
    expect(first).toEqual({ kind: "created", record: { id: 1001, ...newDriver, created_at: expect.any(String), updated_at: expect.any(String) } });
    expect((await client.createDriver({ ...newDriver, no_sim: "JK00000002" })).kind).toBe("created");
    expect(vcf.paths()).toEqual(["POST /api/login", "POST /api/master/driver", "POST /api/master/driver"]);
    const [token] = vcf.issuedTokens;
    expect(vcf.calls[1]).toMatchObject({ authorization: `Bearer ${token}`, contentType: "application/json", accept: "application/json", body: newDriver });
    expect(vcf.calls[2]?.authorization).toBe(`Bearer ${token}`);
  });

  it("logs in again once and retries when another login has made the token useless", async () => {
    const vcf = await startFakeVcf();
    const client = new VcfClient(vcf.url, FAKE_ACCOUNT);
    await client.createDriver(newDriver);
    vcf.invalidateTokens();
    expect((await client.createDriver({ ...newDriver, no_sim: "JK00000002" })).kind).toBe("created");
    expect(vcf.paths()).toEqual(["POST /api/login", "POST /api/master/driver", "POST /api/master/driver", "POST /api/login", "POST /api/master/driver"]);
    expect(vcf.calls[4]?.authorization).toBe(`Bearer ${vcf.issuedTokens[1]}`);
  });

  it("gives up after a second 401", async () => {
    const vcf = await startFakeVcf();
    const client = new VcfClient(vcf.url, FAKE_ACCOUNT);
    vcf.refuseAllTokens();
    await expect(client.createDriver(newDriver)).rejects.toThrow(VcfAuthError);
    expect(vcf.paths()).toEqual(["POST /api/login", "POST /api/master/driver", "POST /api/login", "POST /api/master/driver"]);
  });

  it("answers a 422, a 403 and failures as results or errors the caller can tell apart", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1, { no_sim: "JK12345678" })] });
    const client = new VcfClient(vcf.url, FAKE_ACCOUNT);
    expect(await client.createDriver(newDriver)).toEqual({
      kind: "rejected",
      message: "The no sim has already been taken.",
      fields: { no_sim: ["The no sim has already been taken."] },
    });
    vcf.setRole("operator");
    expect(await client.createDriver({ ...newDriver, no_sim: "JK00000002" })).toEqual({ kind: "forbidden", message: "This action is unauthorized." });
    vcf.setRole("admin");
    vcf.failOnce("/api/master/driver", 503);
    await expect(client.createDriver(newDriver)).rejects.toMatchObject({ name: "VcfError", status: 503 });
    vcf.failOnce("/api/master/driver", "drop");
    await expect(client.createDriver(newDriver)).rejects.toMatchObject({ name: "VcfError", status: undefined });
  });

  it("tells wrong credentials apart from a login that could not be made", async () => {
    const vcf = await startFakeVcf();
    const wrong = new VcfClient(vcf.url, { username: FAKE_ACCOUNT.username, password: "not-the-password" });
    const error = await wrong.createDriver(newDriver).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VcfLoginError);
    expect(error).toMatchObject({ wrongCredentials: true });
    expect(String((error as Error).message)).not.toContain("not-the-password");
    expect(vcf.paths()).toEqual(["POST /api/login"]);

    vcf.failOnce("/api/login", 500);
    const down = await new VcfClient(vcf.url, FAKE_ACCOUNT).login().catch((caught: unknown) => caught);
    expect(down).toBeInstanceOf(VcfLoginError);
    expect(down).toMatchObject({ wrongCredentials: false, status: 500 });
  });

  it("searches the public list", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1, { no_sim: "JK 1234 5678" }), registryDriver(2)] });
    const client = new VcfClient(vcf.url);
    expect((await client.searchDrivers("1234 5678")).map((row) => row.id)).toEqual([1]);
    expect(vcf.requests).toEqual([{ method: "GET", url: "/api/master/drivers?search=1234+5678" }]);
  });

  it("can push only when the URL, the username and the password are all configured", async () => {
    expect(vcfClientFor(null)).toBeNull();
    expect(vcfClientFor({ url: "http://registry.test", username: null, password: null })?.canPush).toBe(false);
    expect(vcfClientFor({ url: "http://registry.test", username: "pusher", password: null })?.canPush).toBe(false);
    expect(vcfClientFor({ url: "http://registry.test", username: "pusher", password: "secret" })?.canPush).toBe(true);
    const reader = new VcfClient("http://registry.test");
    await expect(reader.login()).rejects.toThrow(VcfError);
  });
});
