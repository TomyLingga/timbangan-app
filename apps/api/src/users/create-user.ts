import { eq, sql } from "drizzle-orm";
import { hashPassword } from "../auth/passwords.js";
import { grantEverything, partnerDefaults, replacePermissions } from "../auth/permissions.js";
import type { Orm } from "../db/client.js";
import { partners, users } from "../db/schema.js";

export interface NewUser {
  username: string;
  fullName: string;
  kind: "INTERNAL" | "PARTNER";
  /** The company of a PARTNER account; not allowed on an INTERNAL one. */
  partnerId?: number;
  /** EDIT on every active module; INTERNAL accounts only. */
  admin?: boolean;
  password: string;
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Creates an account that signs in with a password. An INTERNAL account gets no permission unless `admin`;
 * a PARTNER account gets the defaults of its company's kinds. Throws an Error that says what is wrong.
 */
export async function createUser(orm: Orm, input: NewUser): Promise<{ id: number }> {
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new Error(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (input.kind === "PARTNER" && input.partnerId === undefined) throw new Error("A PARTNER account needs --partner-id.");
  if (input.kind === "INTERNAL" && input.partnerId !== undefined) throw new Error("An INTERNAL account cannot have a partner id.");
  if (input.kind === "PARTNER" && input.admin) throw new Error("--admin is only for INTERNAL accounts.");

  let company: { isSupplier: boolean; isTransporter: boolean; isCustomer: boolean } | undefined;
  if (input.partnerId !== undefined) {
    [company] = await orm
      .select({ isSupplier: partners.isSupplier, isTransporter: partners.isTransporter, isCustomer: partners.isCustomer })
      .from(partners)
      .where(eq(partners.id, input.partnerId));
    if (!company) throw new Error(`Partner ${input.partnerId} does not exist.`);
  }
  const [taken] = await orm
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.username})`, input.username.toLowerCase()));
  if (taken) throw new Error(`Username ${input.username} is already in use.`);

  const passwordHash = await hashPassword(input.password);
  return orm.transaction(async (tx) => {
    const now = new Date();
    const [created] = await tx
      .insert(users)
      .values({ kind: input.kind, partnerId: input.partnerId ?? null, username: input.username, fullName: input.fullName, passwordHash })
      .returning({ id: users.id });
    if (!created) throw new Error("The account was not created.");
    if (input.admin) await grantEverything(tx, created.id, now);
    else if (company) await replacePermissions(tx, created.id, partnerDefaults(company), null, now);
    return created;
  });
}
