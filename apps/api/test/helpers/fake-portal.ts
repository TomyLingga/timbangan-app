// A stand-in for the company portal on 127.0.0.1. It answers POST /api/sso/verify the way
// portal-app-be does: { success: true, data } on success, { success: false, error } with status 400 for a
// refused token and 422 with `details` when the body fails validation. A token works once.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

export interface PortalUser {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  employeeId: string | null;
  employee: Record<string, unknown> | null;
}

export interface ReceivedRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function portalUser(overrides: Partial<PortalUser> = {}, employee: Record<string, unknown> = {}): PortalUser {
  return {
    id: "5b0c2a52-7d1f-4d0e-9b57-0a8f1f6f0001",
    email: "Budi.Santoso@inl.co.id",
    role: "user",
    isActive: true,
    employeeId: "9d2f6a10-1111-4222-8333-000000000001",
    employee: {
      id: "9d2f6a10-1111-4222-8333-000000000001",
      nrk: "INL-0421",
      nama: "Budi Santoso",
      namaLengkap: "Budi Santoso",
      jenisKelamin: "L",
      jabatan: "Staff Logistik",
      tanggalMasuk: "2019-03-01",
      fotoProfil: null,
      isActive: true,
      nomorHp: "0800000000",
      statusKaryawan: { id: "s1", kode: "TETAP", label: "Tetap" },
      atasan: null,
      grade: { id: "g1", kode: "G4", label: "Staff", level: 4 },
      unit: { id: "u1", kode: "LOG", nama: "Logistik", tipe: "departemen", parentId: "u0", path: "Operasional / Logistik", hierarchy: [] },
      penempatanArea: null,
      ...employee,
    },
    ...overrides,
  };
}

export async function startFakePortal() {
  const tickets = new Map<string, PortalUser | { error: string }>();
  const requests: ReceivedRequest[] = [];

  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({ method: request.method ?? "", url: request.url ?? "", contentType: request.headers["content-type"], body });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    };
    if (request.method !== "POST" || request.url !== "/api/sso/verify") return send(404, { success: false, error: "File atau resource tidak ditemukan." });

    const { token, app_id: appId } = (body ?? {}) as { token?: unknown; app_id?: unknown };
    if (typeof token !== "string" || token === "" || typeof appId !== "string" || !UUID.test(appId)) {
      return send(422, { success: false, error: "Validasi gagal", details: [{ field: "app_id", message: "app_id tidak valid" }] });
    }
    const ticket = tickets.get(token);
    tickets.delete(token);
    if (!ticket) return send(400, { success: false, error: "Token tidak valid" });
    if ("error" in ticket) return send(400, { success: false, error: ticket.error });
    return send(200, { success: true, data: ticket });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // fetch keeps its connection open; without closing it the server would wait for it to time out
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  onTestFinished(async () => {
    if (server.listening) await close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    apiUrl: `${origin}/api`,
    requests,
    /** Registers a one-time token that verifies as this user, or is refused with this error. */
    ticket(token: string, answer: PortalUser | { error: string }) {
      tickets.set(token, answer);
    },
    close,
  };
}
