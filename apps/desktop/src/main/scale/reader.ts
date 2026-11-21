// One interface for every way the program reads the scale indicator: TCP, serial (RS-232) and the simulator.

import type { ScaleStatus } from "../../shared/bridge";

export type { ScaleStatus };

export interface ScaleListener {
  /** A weight in whole kilograms, as often as the indicator sends one. */
  weight(kg: number): void;
  status(status: ScaleStatus, detail?: string): void;
}

export interface ScaleReader {
  start(listener: ScaleListener): void;
  stop(): Promise<void>;
}
