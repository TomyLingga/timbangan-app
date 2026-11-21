// A stand-in for the central driver registry. It answers the read calls the application may make
// (GET /api/master/drivers, optionally with ?search=, and GET /api/master/transporters, each with
// { data: [...], message }) and the two write calls: POST /api/login and POST /api/master/driver.
// Like the registry, a successful login invalidates every other token of the account.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

export type RegistryRow = Record<string, unknown>;

export const registryDriver = (id: number, overrides: RegistryRow = {}): RegistryRow => ({
  id,
  nama_supir: `Supir ${id}`,
  no_sim: `99000000${String(id).padStart(4, "0")}`,
  jenis_sim: "B2 UMUM",
  tgl_berlaku_sim: "2028-05-31",
  is_active: true,
  created_at: "2026-01-05T02:00:00.000000Z",
  updated_at: "2026-01-05T02:00:00.000000Z",
  status: "normal",
  ...overrides,
});

export const registryTransporter = (id: number, overrides: RegistryRow = {}): RegistryRow => ({
  id,
  nama_transporter: `Transporter ${id}`,
  kode: `T${id}`,
  is_active: true,
  ...overrides,
});

/** The account the fake accepts unless a test gives another one. */
export const FAKE_ACCOUNT = { username: "pusher", password: "pusher-secret-0123" };

export interface FakeVcfCall {
  method: string;
  /** Path with the query string. */
  url: string;
  authorization: string | null;
  contentType: string | null;
  accept: string | null;
  body: unknown;
}

/** A one-off answer: an HTTP status, a status with a body, or a dropped connection. */
type Outcome = number | "drop" | { status: number; body: unknown };

const REQUIRED = ["nama_supir", "no_sim", "jenis_sim", "tgl_berlaku_sim"] as const;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startFakeVcf(data: { drivers?: RegistryRow[]; transporters?: RegistryRow[]; account?: { username: string; password: string } } = {}) {
  const drivers = data.drivers ?? [];
  const transporters = data.transporters ?? [];
  const account = data.account ?? FAKE_ACCOUNT;
  const requests: { method: string; url: string }[] = [];
  const calls: FakeVcfCall[] = [];
  const issuedTokens: string[] = [];
  let liveTokens: string[] = [];
  let role = "admin";
  let refuseTokens = false;
  let failure: { path?: string; status: number } | null = null;
  let createdStatus: string | null = null;
  const onceFailures = new Map<string, Outcome[]>();
  let gate: Promise<void> | null = null;

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = request.url ?? "";
    const path = new URL(url, "http://fake.test").pathname;
    requests.push({ method: request.method ?? "", url });
    calls.push({
      method: request.method ?? "",
      url,
      authorization: request.headers.authorization ?? null,
      contentType: request.headers["content-type"] ?? null,
      accept: request.headers.accept ?? null,
      body,
    });
    if (gate) await gate;
    const send = (status: number, payload: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    const queued = onceFailures.get(path)?.shift();
    if (queued === "drop") {
      request.socket.destroy();
      return;
    }
    if (typeof queued === "number") return send(queued, { message: "Server Error" });
    if (queued) return send(queued.status, queued.body);
    if (failure && (failure.path === undefined || failure.path === url || failure.path === path)) return send(failure.status, { message: "Server Error" });

    if (request.method === "POST" && path === "/api/login") {
      const given = (body ?? {}) as { username?: unknown; password?: unknown };
      if (given.username !== account.username || given.password !== account.password) return send(422, { message: "Username atau password salah." });
      const token = `${issuedTokens.length + 1}|${randomUUID()}`;
      issuedTokens.push(token);
      liveTokens = [token];
      return send(200, { message: "Login berhasil.", token, user: { id: 1, nama: "Akun Uji", username: account.username, role } });
    }

    if (request.method === "POST" && path === "/api/master/driver") {
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      if (refuseTokens || !token || !liveTokens.includes(token)) return send(401, { message: "Unauthenticated." });
      if (role !== "admin") return send(403, { message: "This action is unauthorized." });
      const input = (body ?? {}) as Record<string, unknown>;
      const errors: Record<string, string[]> = {};
      for (const field of REQUIRED) if (typeof input[field] !== "string" || input[field] === "") errors[field] = [`The ${field.replace(/_/g, " ")} field is required.`];
      const licence = String(input.no_sim ?? "").toUpperCase();
      if (!errors.no_sim && drivers.some((row) => String(row.no_sim ?? "").toUpperCase() === licence)) errors.no_sim = ["The no sim has already been taken."];
      const first = Object.values(errors)[0];
      if (first) return send(422, { message: first[0], errors });
      const id = Math.max(1000, ...drivers.map((row) => Number(row.id) || 0)) + 1;
      const record = {
        id,
        nama_supir: input.nama_supir,
        no_sim: input.no_sim,
        jenis_sim: input.jenis_sim,
        tgl_berlaku_sim: input.tgl_berlaku_sim,
        is_active: input.is_active ?? true,
        created_at: "2026-11-20T03:00:00.000000Z",
        updated_at: "2026-11-20T03:00:00.000000Z",
      };
      // the list shows the column default; the answer to the create call does not carry it
      drivers.push({ ...record, status: "normal" });
      return send(201, { message: "Driver berhasil ditambahkan.", data: createdStatus ? { ...record, status: createdStatus } : record });
    }

    if (request.method === "GET" && path === "/api/master/drivers") {
      const search = new URL(url, "http://fake.test").searchParams.get("search");
      const word = search?.toLowerCase();
      const rows = word ? drivers.filter((row) => `${row.nama_supir ?? ""}`.toLowerCase().includes(word) || `${row.no_sim ?? ""}`.toLowerCase().includes(word)) : drivers;
      return send(200, { data: rows, message: "OK" });
    }
    if (request.method === "GET" && path === "/api/master/transporters") return send(200, { data: transporters, message: "OK" });
    return send(404, { message: "Not Found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  onTestFinished(async () => {
    if (server.listening) await close();
  });

  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    account,
    drivers,
    transporters,
    requests,
    /** Every request with its headers of interest and its parsed body. */
    calls,
    /** Every token a login handed out, oldest first. */
    issuedTokens,
    /** Paths of the requests, without the query string. */
    paths: () => calls.map((call) => `${call.method} ${new URL(call.url, "http://fake.test").pathname}`),
    /** Makes every request (or the requests for one path) answer this HTTP status. */
    failWith(status: number, path?: string) {
      failure = { status, path };
    },
    recover() {
      failure = null;
    },
    /** The next request to this path answers this status, or has its connection dropped. */
    failOnce(path: string, outcome: Outcome) {
      onceFailures.set(path, [...(onceFailures.get(path) ?? []), outcome]);
    },
    /** What another login elsewhere does: every token handed out so far stops working. */
    invalidateTokens() {
      liveTokens = [];
    },
    /** Every bearer token is refused, even a fresh one. */
    refuseAllTokens() {
      refuseTokens = true;
    },
    /** A status the answer to a create call carries; by default it carries none. */
    setCreatedStatus(value: string | null) {
      createdStatus = value;
    },
    /** The account's role; anything but "admin" may not add drivers. */
    setRole(value: string) {
      role = value;
    },
    /** Makes the server wait before it answers; call the returned function to let the answers go. */
    hold(): () => void {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    close,
  };
}
