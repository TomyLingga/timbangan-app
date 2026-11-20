// A stand-in for the central driver registry. It answers the two read calls the application may make:
// GET /api/master/drivers and GET /api/master/transporters, each with { data: [...], message }.
import { createServer } from "node:http";
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

export async function startFakeVcf(data: { drivers?: RegistryRow[]; transporters?: RegistryRow[] } = {}) {
  const drivers = data.drivers ?? [];
  const transporters = data.transporters ?? [];
  const requests: { method: string; url: string }[] = [];
  let failure: { path?: string; status: number } | null = null;
  let gate: Promise<void> | null = null;

  const server = createServer(async (request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "" });
    if (gate) await gate;
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    if (failure && (failure.path === undefined || failure.path === request.url)) return send(failure.status, { message: "Server Error" });
    if (request.method === "GET" && request.url === "/api/master/drivers") return send(200, { data: drivers, message: "OK" });
    if (request.method === "GET" && request.url === "/api/master/transporters") return send(200, { data: transporters, message: "OK" });
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
    drivers,
    transporters,
    requests,
    /** Makes every request (or the requests for one path) answer this HTTP status. */
    failWith(status: number, path?: string) {
      failure = { status, path };
    },
    recover() {
      failure = null;
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
