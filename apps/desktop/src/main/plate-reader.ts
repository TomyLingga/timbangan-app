// The plate reader service (alpr-id): GET {address}/plate/{camera} answers { plate, raw, fps, status }. A failed
// or unknown read gives null; the weighing never waits on it.

export interface PlateRead {
  plate: string;
  /** online, lagging or offline, as the reader reports its camera. */
  status: string;
}

export interface PlateReader {
  read(camera: number): Promise<PlateRead | null>;
}

export function createPlateReader(options: { baseUrl: string; timeoutMs?: number; fetch?: typeof fetch }): PlateReader {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetch ?? fetch;
  return {
    async read(camera: number): Promise<PlateRead | null> {
      try {
        const response = await fetcher(`${baseUrl}/plate/${camera}`, { signal: AbortSignal.timeout(options.timeoutMs ?? 900) });
        if (!response.ok) return null;
        const body = (await response.json()) as { plate?: unknown; status?: unknown };
        return { plate: typeof body.plate === "string" ? body.plate : "", status: typeof body.status === "string" ? body.status : "unknown" };
      } catch {
        return null;
      }
    },
  };
}
