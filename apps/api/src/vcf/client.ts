// Client of the central driver registry. Reading (the driver list, optionally searched, and the transporter
// list) is public. Adding a driver needs an account: the client logs in on first use and keeps the token in
// memory. A login on the registry deletes every other token of the account, so a token can stop working at
// any time; a 401 leads to one new login and one retry. Neither the password nor the token is ever logged
// or put in an error message.
import type { VcfConfig } from "../config.js";

/** How long one call may take when the caller gives no shorter limit. */
const CALL_TIMEOUT_MS = 60_000;

export class VcfError extends Error {
  override name = "VcfError";
  constructor(
    message: string,
    /** The HTTP status the registry answered; absent when it could not be reached or did not answer in time. */
    readonly status?: number,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

/** The login failed: wrong credentials (the registry answered 422) or no usable answer. */
export class VcfLoginError extends VcfError {
  override name = "VcfLoginError";
  constructor(
    message: string,
    readonly wrongCredentials: boolean,
    status?: number,
    timedOut = false,
  ) {
    super(message, status, timedOut);
  }
}

/** The registry refused a token it had just handed out. */
export class VcfAuthError extends VcfError {
  override name = "VcfAuthError";
}

/** A row as the registry sends it; the sync reads the fields it knows. */
export type RegistryRecord = Record<string, unknown>;

export interface VcfAccount {
  username: string;
  password: string;
}

/** The body of POST /api/master/driver. */
export interface NewRegistryDriver {
  nama_supir: string;
  no_sim: string;
  jenis_sim: string;
  /** YYYY-MM-DD */
  tgl_berlaku_sim: string;
  is_active: boolean;
}

export type CreateDriverResult =
  | { kind: "created"; record: RegistryRecord }
  /** 422: the registry's message and its per-field messages. */
  | { kind: "rejected"; message: string; fields: Record<string, string[]> }
  /** 403: the account may not add drivers. */
  | { kind: "forbidden"; message: string };

/** The client for the configured registry; null when no registry is configured. */
export function vcfClientFor(config: VcfConfig | null): VcfClient | null {
  if (!config) return null;
  return new VcfClient(config.url, config.username && config.password ? { username: config.username, password: config.password } : null);
}

const messageOf = (answer: unknown): string | null => {
  const message = (answer as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
};

function fieldsOf(answer: unknown): Record<string, string[]> {
  const errors = (answer as { errors?: unknown } | null)?.errors;
  if (typeof errors !== "object" || errors === null) return {};
  const fields: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(errors)) {
    const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
    fields[key] = list;
  }
  return fields;
}

export class VcfClient {
  private token: string | null = null;
  private pendingLogin: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly account: VcfAccount | null = null,
  ) {}

  /** Whether an account is configured, so that drivers can be added. */
  get canPush(): boolean {
    return this.account !== null;
  }

  /** Rows with id, nama_supir, no_sim, jenis_sim, tgl_berlaku_sim, is_active, status (normal, warning, blacklist). */
  drivers(): Promise<RegistryRecord[]> {
    return this.list("/api/master/drivers");
  }

  /** Drivers whose name or licence number contains the text. */
  searchDrivers(text: string, signal?: AbortSignal): Promise<RegistryRecord[]> {
    return this.list(`/api/master/drivers?${new URLSearchParams({ search: text })}`, signal);
  }

  /** Rows with id, nama_transporter, kode, is_active. */
  transporters(): Promise<RegistryRecord[]> {
    return this.list("/api/master/transporters");
  }

  /** The text with the password and the token taken out, for text from the registry that is stored or shown. */
  scrub(text: string): string {
    let clean = text;
    for (const secret of [this.account?.password, this.token]) if (secret) clean = clean.split(secret).join("***");
    return clean;
  }

  /** Logs in and keeps the token. Concurrent callers share one login. */
  login(signal?: AbortSignal): Promise<string> {
    this.pendingLogin ??= this.requestToken(signal).finally(() => {
      this.pendingLogin = null;
    });
    return this.pendingLogin;
  }

  /** Adds a driver. A 401 leads to one new login and one retry; a second 401 throws VcfAuthError. */
  async createDriver(driver: NewRegistryDriver, signal?: AbortSignal): Promise<CreateDriverResult> {
    const token = this.token ?? (await this.login(signal));
    let response = await this.post("/api/master/driver", driver, token, signal);
    if (response.status === 401) {
      await response.body?.cancel();
      // another caller may already have logged in again; otherwise log in now
      const fresh = this.token && this.token !== token ? this.token : await this.login(signal);
      response = await this.post("/api/master/driver", driver, fresh, signal);
      if (response.status === 401) {
        await response.body?.cancel();
        this.token = null;
        throw new VcfAuthError("The driver registry refused the token of a fresh login", 401);
      }
    }
    const answer = await this.read(response, signal);
    if (response.status === 201 || response.status === 200) {
      const record = (answer as { data?: unknown } | null)?.data;
      if (typeof record !== "object" || record === null) throw new VcfError("The driver registry gave no data for /api/master/driver", response.status);
      return { kind: "created", record: record as RegistryRecord };
    }
    if (response.status === 422) {
      const fields = fieldsOf(answer);
      return { kind: "rejected", message: messageOf(answer) ?? Object.values(fields).flat()[0] ?? "Data ditolak.", fields };
    }
    if (response.status === 403) return { kind: "forbidden", message: messageOf(answer) ?? "Forbidden" };
    throw new VcfError(`The driver registry answered HTTP ${response.status} for /api/master/driver`, response.status);
  }

  private async requestToken(signal?: AbortSignal): Promise<string> {
    if (!this.account) throw new VcfLoginError("No account for the driver registry is configured", false);
    let response: Response;
    let answer: unknown;
    try {
      response = await this.post("/api/login", { username: this.account.username, password: this.account.password }, null, signal);
      answer = await this.read(response, signal);
    } catch (error) {
      const failed = error as VcfError;
      throw new VcfLoginError(`Login to the driver registry failed: ${failed.message}`, false, undefined, failed.timedOut);
    }
    if (response.status === 422) throw new VcfLoginError("The driver registry refused the username or the password", true, 422);
    const token = (answer as { token?: unknown } | null)?.token;
    if (!response.ok || typeof token !== "string" || !token) {
      throw new VcfLoginError(`Login to the driver registry failed: HTTP ${response.status}`, false, response.status);
    }
    this.token = token;
    return token;
  }

  private async post(path: string, body: unknown, token: string | null, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    return this.fetch(path, { method: "POST", headers, body: JSON.stringify(body) }, signal);
  }

  private async fetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      throw this.unreachable(error);
    }
  }

  /** The JSON body, or null when it is not JSON (the status decides then). */
  private async read(response: Response, signal?: AbortSignal): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw this.unreachable(error);
      return null;
    }
  }

  private unreachable(error: unknown): VcfError {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) return new VcfError("The driver registry did not answer in time", undefined, true);
    const reason = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
    return new VcfError(`The driver registry cannot be reached: ${reason}`);
  }

  private async list(path: string, signal?: AbortSignal): Promise<RegistryRecord[]> {
    const response = await this.fetch(path, { method: "GET", headers: { accept: "application/json" } }, signal);
    if (!response.ok) throw new VcfError(`The driver registry answered HTTP ${response.status} for ${path}`, response.status);
    const answer = (await response.json().catch(() => null)) as { data?: unknown } | null;
    if (!Array.isArray(answer?.data)) throw new VcfError(`The driver registry gave no data for ${path}`);
    return answer.data.filter((row): row is RegistryRecord => typeof row === "object" && row !== null);
  }
}
