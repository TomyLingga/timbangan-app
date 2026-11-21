// The scale indicator over RS-232 through the native `serialport` package. The package is loaded only when this
// driver starts; if it cannot be loaded for this Electron version, the driver reports "unavailable" with the reason
// and the TCP and simulator drivers keep working.
import { createFrameParser } from "../../shared/scale-frame";
import type { ScaleListener, ScaleReader } from "./reader";

export interface SerialOptions {
  path: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: "none" | "even" | "odd";
  stopBits: 1 | 2;
  reconnectMs?: number;
}

interface PortLike {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "close" | "error", listener: (error?: Error) => void): void;
  open(callback: (error: Error | null) => void): void;
  close(callback?: (error: Error | null) => void): void;
  isOpen: boolean;
}

type PortConstructor = new (options: { path: string; baudRate: number; dataBits: 7 | 8; parity: string; stopBits: 1 | 2; autoOpen: false }) => PortLike;

/** Loads the native module; the error text when it cannot. */
export async function loadSerialPort(): Promise<{ SerialPort: PortConstructor } | { error: string }> {
  try {
    const module = (await import("serialport")) as unknown as { SerialPort: PortConstructor };
    return { SerialPort: module.SerialPort };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function createSerialScale(options: SerialOptions): ScaleReader {
  const reconnectMs = options.reconnectMs ?? 3_000;
  let port: PortLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  const retry = (listener: ScaleListener, Port: PortConstructor) => {
    if (!stopped) timer = setTimeout(() => open(listener, Port), reconnectMs);
  };

  const open = (listener: ScaleListener, Port: PortConstructor) => {
    if (stopped) return;
    listener.status("connecting");
    const parser = createFrameParser();
    let link: PortLike;
    try {
      link = new Port({ path: options.path, baudRate: options.baudRate, dataBits: options.dataBits, parity: options.parity, stopBits: options.stopBits, autoOpen: false });
    } catch (error) {
      listener.status("disconnected", error instanceof Error ? error.message : String(error));
      retry(listener, Port);
      return;
    }
    port = link;
    link.on("data", (chunk: Buffer) => {
      for (const kg of parser.push(chunk.toString("latin1"))) listener.weight(kg);
    });
    link.on("error", () => undefined);
    link.on("close", () => {
      if (port === link) port = null;
      if (stopped) return;
      listener.status("disconnected", options.path);
      retry(listener, Port);
    });
    link.open((error) => {
      if (stopped) return;
      if (error) {
        if (port === link) port = null;
        listener.status("disconnected", error.message);
        retry(listener, Port);
        return;
      }
      listener.status("connected");
    });
  };

  return {
    start(listener) {
      stopped = false;
      listener.status("connecting");
      void loadSerialPort().then((loaded) => {
        if (stopped) return;
        if ("error" in loaded) {
          listener.status("unavailable", `Modul serial tidak bisa dimuat: ${loaded.error}`);
          return;
        }
        open(listener, loaded.SerialPort);
      });
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const link = port;
      port = null;
      if (link?.isOpen) await new Promise<void>((resolve) => link.close(() => resolve()));
    },
  };
}
