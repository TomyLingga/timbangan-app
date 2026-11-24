import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const baseUrl = (key: string) =>
  z
    .url(`${key} must be a URL`)
    .transform((value) => value.replace(/\/+$/, ""));

/** Supertonic 3 preset voices; the speaker id of the model is the position in this list (F2 is 1). */
export const TTS_VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

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
  // the stock.location whose internal children are the storage tanks; without it the sync skips the tanks
  ODOO_TANK_PARENT_LOCATION_ID: z.coerce.number("must be the numeric id of the Odoo location").int().positive().optional(),
  PORTAL_API_URL: baseUrl("PORTAL_API_URL").optional(),
  PORTAL_WEB_URL: baseUrl("PORTAL_WEB_URL").optional(),
  PORTAL_APP_NAME: z.string().optional(),
  VCF_URL: baseUrl("VCF_URL").optional(),
  VCF_USERNAME: z.string().optional(),
  VCF_PASSWORD: z.string().optional(),
  // portal emails that get EDIT on every active module at each sign-in; comma separated
  BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  // the voice of the weighbridge answers: off (text and a tone only) or supertonic (Supertonic 3, on this machine)
  TTS_ENGINE: z.enum(["off", "supertonic"], "must be off or supertonic").default("off"),
  // where the audio of each sentence is kept, per engine, voice and speed
  TTS_CACHE_DIR: z.string().default(".data/tts-cache"),
  // supertonic: the folder with the seven model files; required when TTS_ENGINE=supertonic
  TTS_MODEL_DIR: z.string().optional(),
  // supertonic: preset voice F1..F5 (female) or M1..M5 (male)
  TTS_VOICE: z.enum(TTS_VOICES, `must be one of ${TTS_VOICES.join(", ")}`).default("F2"),
  // supertonic: 1.0 is the normal pace
  TTS_SPEED: z.coerce.number("must be a number").min(0.5, "must be 0.5 to 2").max(2, "must be 0.5 to 2").default(1),
  // supertonic: CPU threads for one synthesis
  TTS_THREADS: z.coerce.number("must be a whole number").int("must be a whole number").min(1).max(32).default(4),
  // where uploaded photos are kept; each file is stored under a random key below this folder
  FILE_STORAGE_DIR: z.string().default(".data/files"),
  // the old weighbridge database, read by `npm run legacy:import` in a read-only session
  LEGACY_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must start with postgres:// or postgresql://").optional(),
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

export type TtsConfig =
  | { engine: "off"; cacheDir: string }
  | { engine: "supertonic"; cacheDir: string; modelDir: string; voice: TtsVoice; speed: number; threads: number };

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
  /** The Odoo stock.location whose internal children are the tanks; null: the sync skips the tank step. */
  odooTankParentLocationId: number | null;
  portal: PortalConfig | null;
  vcf: VcfConfig | null;
  /** Lower case; compared with the portal email of an account at sign-in. */
  bootstrapAdminEmails: string[];
  tts: TtsConfig;
  files: { dir: string };
  /** The old weighbridge database for `npm run legacy:import`; null when not set. */
  legacyDatabaseUrl: string | null;
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
    odooTankParentLocationId: e.ODOO_TANK_PARENT_LOCATION_ID ?? null,
    portal:
      e.PORTAL_API_URL && e.PORTAL_WEB_URL && e.PORTAL_APP_NAME
        ? { apiUrl: e.PORTAL_API_URL, webUrl: e.PORTAL_WEB_URL, appName: e.PORTAL_APP_NAME }
        : null,
    vcf: e.VCF_URL ? { url: e.VCF_URL, username: e.VCF_USERNAME ?? null, password: e.VCF_PASSWORD ?? null } : null,
    bootstrapAdminEmails: (e.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    tts: ttsConfig(e),
    files: { dir: e.FILE_STORAGE_DIR },
    legacyDatabaseUrl: e.LEGACY_DATABASE_URL ?? null,
  };
}

function ttsConfig(e: z.infer<typeof envSchema>): TtsConfig {
  if (e.TTS_ENGINE === "off") return { engine: "off", cacheDir: e.TTS_CACHE_DIR };
  if (!e.TTS_MODEL_DIR) throw new ConfigError("Invalid configuration:\n  TTS_MODEL_DIR: is required when TTS_ENGINE=supertonic (the folder with the Supertonic 3 model files)");
  return { engine: "supertonic", cacheDir: e.TTS_CACHE_DIR, modelDir: e.TTS_MODEL_DIR, voice: e.TTS_VOICE, speed: e.TTS_SPEED, threads: e.TTS_THREADS };
}
