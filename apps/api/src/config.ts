import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const baseUrl = (key: string) =>
  z
    .url(`${key} must be a URL`)
    .transform((value) => value.replace(/\/+$/, ""));

const envSchema = z.object({
  // 0 lets the operating system pick a free port
  PORT: z.coerce.number("must be a port number").int("must be a port number").min(0).max(65535).default(3100),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z
    .string("is required")
    .regex(/^(pglite|postgres|postgresql):\/\//, "must start with pglite://, postgres:// or postgresql://"),
  JWT_SECRET: z.string("is required").min(32, "must be at least 32 characters"),
  WEB_ORIGIN: baseUrl("WEB_ORIGIN").default("http://localhost:3000"),
  ACCESS_TOKEN_TTL_S: z.coerce.number("must be a number of seconds").int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number("must be a number of days").int().positive().default(30),
  ODOO_URL: baseUrl("ODOO_URL").optional(),
  ODOO_DB: z.string().optional(),
  ODOO_UID: z.coerce.number("must be the numeric id of the Odoo user").int().positive().optional(),
  ODOO_PASSWORD: z.string().optional(),
  PORTAL_API_URL: baseUrl("PORTAL_API_URL").optional(),
  PORTAL_WEB_URL: baseUrl("PORTAL_WEB_URL").optional(),
  PORTAL_APP_NAME: z.string().optional(),
  VCF_URL: baseUrl("VCF_URL").optional(),
  VCF_USERNAME: z.string().optional(),
  VCF_PASSWORD: z.string().optional(),
  // portal emails that get EDIT on every active module at each sign-in; comma separated
  BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  // the voice of the weighbridge answers; "off" is the only engine built so far
  TTS_ENGINE: z.enum(["off"], "must be off (the only speech engine built so far)").default("off"),
  // where the audio of each sentence is kept, per engine
  TTS_CACHE_DIR: z.string().default(".data/tts-cache"),
  // where uploaded photos are kept; each file is stored under a random key below this folder
  FILE_STORAGE_DIR: z.string().default(".data/files"),
});

export interface OdooConfig {
  url: string;
  db: string;
  uid: number;
  password: string;
}

export interface PortalConfig {
  /** Base of the portal API, ending in /api (without a trailing slash). */
  apiUrl: string;
  webUrl: string;
  appName: string;
}

export interface VcfConfig {
  url: string;
  /** Reading the registry needs no account; sending drivers to it needs both of these. */
  username: string | null;
  password: string | null;
}

export interface TtsConfig {
  engine: "off";
  cacheDir: string;
}

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  webOrigin: string;
  accessTokenTtlS: number;
  refreshTokenTtlDays: number;
  /** null when the group is incomplete: the routes that need it answer 503 NOT_CONFIGURED. */
  odoo: OdooConfig | null;
  portal: PortalConfig | null;
  vcf: VcfConfig | null;
  /** Lower case; compared with the portal email of an account at sign-in. */
  bootstrapAdminEmails: string[];
  tts: TtsConfig;
  files: { dir: string };
}

/** Validates the environment. An empty value counts as absent, so `KEY=` in .env falls back to the default. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    webOrigin: e.WEB_ORIGIN,
    accessTokenTtlS: e.ACCESS_TOKEN_TTL_S,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    odoo:
      e.ODOO_URL && e.ODOO_DB && e.ODOO_UID && e.ODOO_PASSWORD
        ? { url: e.ODOO_URL, db: e.ODOO_DB, uid: e.ODOO_UID, password: e.ODOO_PASSWORD }
        : null,
    portal:
      e.PORTAL_API_URL && e.PORTAL_WEB_URL && e.PORTAL_APP_NAME
        ? { apiUrl: e.PORTAL_API_URL, webUrl: e.PORTAL_WEB_URL, appName: e.PORTAL_APP_NAME }
        : null,
    vcf: e.VCF_URL ? { url: e.VCF_URL, username: e.VCF_USERNAME ?? null, password: e.VCF_PASSWORD ?? null } : null,
    bootstrapAdminEmails: (e.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    tts: { engine: e.TTS_ENGINE, cacheDir: e.TTS_CACHE_DIR },
    files: { dir: e.FILE_STORAGE_DIR },
  };
}
