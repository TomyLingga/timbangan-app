// The daily log: one JSON line per entry in <dir>/YYYY-MM-DD.log (local date). Stable readings, API calls with
// status and duration, errors. Fields that could hold a secret are written as "[hidden]".
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const SECRET_KEYS = /^(stationkey|key|pin|x-station-key|authorization|password|token)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? "[hidden]" : redact(item, depth + 1)]));
}

const pad = (value: number) => String(value).padStart(2, "0");
const dayOf = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export interface DailyLog {
  write(event: string, data?: Record<string, unknown>): void;
  /** Resolves when every line written so far is on disk. */
  flush(): Promise<void>;
}

export function createDailyLog(dir: string, now: () => number): DailyLog {
  let pending: Promise<void> = mkdir(dir, { recursive: true }).then(() => undefined);
  return {
    write(event, data = {}) {
      const time = now();
      const line = `${JSON.stringify({ at: new Date(time).toISOString(), event, ...(redact(data) as Record<string, unknown>) })}\n`;
      const file = join(dir, `${dayOf(time)}.log`);
      // a log that cannot be written must never stop the weighing
      pending = pending.then(() => appendFile(file, line, "utf8")).catch(() => undefined);
    },
    flush: () => pending,
  };
}
