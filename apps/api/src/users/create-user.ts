import { eq, sql } from "drizzle-orm";
import { hashPassword } from "../auth/passwords.js";
import type { Orm } from "../db/client.js";
import { partners, roles, userRoles, users } from "../db/schema.js";

export interface NewUser {
  username: string;
  fullName: string;
  kind: "INTERNAL" | "PARTNER";
  /** The company of a PARTNER account; not allowed on an INTERNAL one. */
  partnerId?: number;
  role: string;
  password: string;
}

export const MIN_PASSWORD_LENGTH = 8;

/** Creates an account that signs in with a password, with one role. Throws an Error that says what is wrong. */
export async function createUser(orm: Orm, input: NewUser): Promise<{ id: number }> {
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new Error(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (input.kind === "PARTNER" && input.partnerId === undefined) throw new Error("A PARTNER account needs --partner-id.");
  if (input.kind === "INTERNAL" && input.partnerId !== undefined) throw new Error("An INTERNAL account cannot have a partner id.");

  const [role] = await orm.select().from(roles).where(eq(roles.code, input.role));
  if (!role) throw new Error(`Role ${input.role} does not exist.`);
  if (role.scope !== input.kind) throw new Error(`Role ${input.role} is for ${role.scope} accounts, not for ${input.kind}.`);

  if (input.partnerId !== undefined) {
    const [partner] = await orm.select({ id: partners.id }).from(partners).where(eq(partners.id, input.partnerId));
    if (!partner) throw new Error(`Partner ${input.partnerId} does not exist.`);
  }
  const [taken] = await orm
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.username})`, input.username.toLowerCase()));
  if (taken) throw new Error(`Username ${input.username} is already in use.`);

  const passwordHash = await hashPassword(input.password);
  return orm.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({ kind: input.kind, partnerId: input.partnerId ?? null, username: input.username, fullName: input.fullName, passwordHash })
      .returning({ id: users.id });
    if (!created) throw new Error("The account was not created.");
    await tx.insert(userRoles).values({ userId: created.id, roleCode: input.role });
    return created;
  });
}
