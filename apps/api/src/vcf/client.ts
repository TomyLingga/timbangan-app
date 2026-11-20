// Read-only client of the central driver registry. It can make two calls, both GET and both without
// authentication: the list of drivers and the list of transporters. Sending drivers to the registry is not
// implemented.

export class VcfError extends Error {
  override name = "VcfError";
}

/** A row as the registry sends it; the sync reads the fields it knows. */
export type RegistryRecord = Record<string, unknown>;

export class VcfClient {
  constructor(private readonly baseUrl: string) {}

  /** Rows with id, nama_supir, no_sim, jenis_sim, tgl_berlaku_sim, is_active, status (normal, warning, blacklist). */
  drivers(): Promise<RegistryRecord[]> {
    return this.list("/api/master/drivers");
  }

  /** Rows with id, nama_transporter, kode, is_active. */
  transporters(): Promise<RegistryRecord[]> {
    return this.list("/api/master/transporters");
  }

  private async list(path: string): Promise<RegistryRecord[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      const reason = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
      throw new VcfError(`The driver registry cannot be reached: ${reason}`);
    }
    if (!response.ok) throw new VcfError(`The driver registry answered HTTP ${response.status} for ${path}`);
    const answer = (await response.json().catch(() => null)) as { data?: unknown } | null;
    if (!Array.isArray(answer?.data)) throw new VcfError(`The driver registry gave no data for ${path}`);
    return answer.data.filter((row): row is RegistryRecord => typeof row === "object" && row !== null);
  }
}
