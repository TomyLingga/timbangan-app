import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ScaleStatus } from "../src/main/scale/reader";
import { createSerialScale } from "../src/main/scale/serial";
import { createSimulatorScale } from "../src/main/scale/simulator";
import { createTcpScale } from "../src/main/scale/tcp";

const until = async (check: () => boolean, ms = 2_000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("TCP scale", () => {
  it("reads weights from lines split across packets, and connects again after the indicator drops the link", async () => {
    const sockets: Socket[] = [];
    server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server?.listen(0, "localhost", resolve));
    const { port } = server.address() as AddressInfo;
    const weights: number[] = [];
    const statuses: ScaleStatus[] = [];
    const scale = createTcpScale({ host: "localhost", port, reconnectMs: 50 });
    scale.start({ weight: (kg) => weights.push(kg), status: (status) => statuses.push(status) });
    await until(() => sockets.length === 1);
    sockets[0]?.write("ST,GS 99 415");
    sockets[0]?.write("00 kg\r\nST,GS 99 41520 kg\r\n");
    await until(() => weights.length === 2);
    expect(weights).toEqual([41_500, 41_520]);
    sockets[0]?.destroy();
    await until(() => sockets.length === 2);
    sockets[1]?.write("ST,GS 99 100 kg\n");
    await until(() => weights.length === 3);
    expect(statuses).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
    await scale.stop();
  });
});

describe("simulator scale", () => {
  it("sends the set weight as indicator lines through the same parser", async () => {
    const weights: number[] = [];
    const scale = createSimulatorScale({ intervalMs: 20 });
    scale.start({ weight: (kg) => weights.push(kg), status: () => {} });
    scale.set(12_340);
    await until(() => weights.filter((kg) => kg === 12_340).length >= 2);
    scale.set(0);
    await until(() => weights.at(-1) === 0);
    await scale.stop();
  });
});

describe("serial scale", () => {
  it("reports a missing port without throwing", async () => {
    const statuses: [ScaleStatus, string | undefined][] = [];
    const scale = createSerialScale({ path: "COM_DOES_NOT_EXIST", baudRate: 2400, dataBits: 7, parity: "none", stopBits: 1, reconnectMs: 10_000 });
    scale.start({ weight: () => {}, status: (status, detail) => statuses.push([status, detail]) });
    await until(() => statuses.some(([status]) => status === "disconnected" || status === "unavailable"));
    await scale.stop();
    expect(statuses[0]?.[0]).toBe("connecting");
  });
});
