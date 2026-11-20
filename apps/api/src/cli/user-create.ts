// npm run user:create -- --username <u> --full-name <n> --kind INTERNAL|PARTNER [--partner-id <id>] --role <ROLE_CODE>
// The password comes from NEW_USER_PASSWORD; without it a random one is generated and printed once.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb, type Database } from "../db/client.js";
import { createUser } from "../users/create-user.js";

const USAGE = "Usage: npm run user:create -- --username <u> --full-name <n> --kind INTERNAL|PARTNER [--partner-id <id>] --role <ROLE_CODE>";

export type Env = Record<string, string | undefined>;
export type Print = (line: string) => void;

export async function runUserCreate(args: string[], env: Env, print: Print, open: (url: string) => Promise<Database> = createDb): Promise<number> {
  let database: Database | undefined;
  try {
    const { values } = parseArgs({
      args,
      options: {
        username: { type: "string" },
        "full-name": { type: "string" },
        kind: { type: "string" },
        "partner-id": { type: "string" },
        role: { type: "string" },
      },
    });
    const missing = (["username", "full-name", "kind", "role"] as const).filter((key) => !values[key]);
    if (missing.length > 0) throw new Error(`Missing ${missing.map((key) => `--${key}`).join(", ")}.\n${USAGE}`);
    if (values.kind !== "INTERNAL" && values.kind !== "PARTNER") throw new Error("--kind must be INTERNAL or PARTNER.");
    const partnerId = values["partner-id"] === undefined ? undefined : Number(values["partner-id"]);
    if (partnerId !== undefined && !Number.isSafeInteger(partnerId)) throw new Error("--partner-id must be a number.");

    const generated = env.NEW_USER_PASSWORD ? null : randomBytes(18).toString("base64url");
    database = await open(loadConfig(env).databaseUrl);
    const { id } = await createUser(database.db, {
      username: values.username as string,
      fullName: values["full-name"] as string,
      kind: values.kind,
      partnerId,
      role: values.role as string,
      password: env.NEW_USER_PASSWORD ?? (generated as string),
    });
    print(`Created user ${values.username} (id ${id}, ${values.kind}, role ${values.role}).`);
    if (generated) print(`Password (shown once): ${generated}`);
    return 0;
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await runUserCreate(process.argv.slice(2), process.env, console.log);
