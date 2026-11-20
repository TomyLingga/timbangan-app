// Read-only client for Odoo 13 over JSON-RPC. The only call it can make is object.execute_kw … search_read
// with the configured user id. It never calls common.authenticate, which would record a login in Odoo.
import type { OdooConfig } from "../config.js";

export class OdooError extends Error {
  override name = "OdooError";
}

export type OdooRecord = { id: number } & Record<string, unknown>;
export type OdooDomain = [field: string, operator: string, value: unknown][];

export const ODOO_PAGE_SIZE = 500;

export class OdooClient {
  constructor(
    private readonly config: OdooConfig,
    private readonly pageSize = ODOO_PAGE_SIZE,
  ) {}

  /** Every record that matches the domain, ordered by id, read page by page. */
  async searchRead(model: string, domain: OdooDomain, fields: string[]): Promise<OdooRecord[]> {
    const records: OdooRecord[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const page = await this.call(model, domain, { fields, limit: this.pageSize, offset, order: "id" });
      records.push(...page);
      if (page.length < this.pageSize) return records;
    }
  }

  private async call(model: string, domain: OdooDomain, options: Record<string, unknown>): Promise<OdooRecord[]> {
    const { url, db, uid, password } = this.config;
    let response: Response;
    try {
      response = await fetch(`${url}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          id: 1,
          params: { service: "object", method: "execute_kw", args: [db, uid, password, model, "search_read", [domain], options] },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
      throw new OdooError(`Odoo cannot be reached: ${reason}`);
    }
    if (!response.ok) throw new OdooError(`Odoo answered HTTP ${response.status} for ${model}`);

    const answer = (await response.json().catch(() => null)) as { result?: unknown; error?: { message?: string; data?: { message?: string } } } | null;
    if (answer?.error) throw new OdooError(`Odoo error for ${model}: ${answer.error.data?.message ?? answer.error.message ?? "unknown error"}`);
    if (!Array.isArray(answer?.result)) throw new OdooError(`Odoo gave no result for ${model}`);
    return answer.result as OdooRecord[];
  }
}
