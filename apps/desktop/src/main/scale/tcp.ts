// The scale indicator over TCP (the old program used port 3002). Reads text lines, connects again after the link
// drops.
import { createConnection, type Socket } from "node:net";
import { createFrameParser } from "../../shared/scale-frame";
import type { ScaleListener, ScaleReader } from "./reader";

export function createTcpScale(options: { host: string; port: number; reconnectMs?: number }): ScaleReader {
  const reconnectMs = options.reconnectMs ?? 2_000;
  let socket: Socket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  const connect = (listener: ScaleListener) => {
    if (stopped) return;
    const parser = createFrameParser();
    listener.status("connecting");
    const link = createConnection({ host: options.host, port: options.port });
    socket = link;
    link.setEncoding("latin1");
    link.setKeepAlive(true, 10_000);
    link.on("connect", () => listener.status("connected"));
    link.on("data", (chunk: string) => {
      for (const kg of parser.push(chunk)) listener.weight(kg);
    });
    link.on("error", () => undefined);
    link.on("close", () => {
      if (socket === link) socket = null;
      if (stopped) return;
      listener.status("disconnected", `${options.host}:${options.port}`);
      timer = setTimeout(() => connect(listener), reconnectMs);
    });
  };

  return {
    start(listener) {
      stopped = false;
      connect(listener);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.destroy();
      socket = null;
    },
  };
}
