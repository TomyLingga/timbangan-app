import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { users } from "../db/schema.js";
import { AppError, notConfigured } from "../errors.js";
import { loadAccount } from "./guard.js";
import { grantEverything } from "./permissions.js";
import { verifyPortalToken } from "./portal.js";
import { issueSession } from "./sessions.js";

const exchangeBody = z.object({
  token: z.string("Token wajib diisi.").min(1, "Token wajib diisi."),
  appId: z.uuid("appId tidak valid."),
});

/** Staff sign in through the company portal: the portal vouches for the user, this application keeps the permissions. */
export function registerSsoRoutes(app: FastifyInstance, context: AppContext): void {
  const orm = context.database.db;
  const portalConfig = () => {
    if (!context.config.portal) throw notConfigured("Portal perusahaan");
    return context.config.portal;
  };

  app.get("/api/auth/sso/start", async (_request, reply) => {
    const portal = portalConfig();
    return reply.redirect(`${portal.webUrl}/launch?app=${encodeURIComponent(portal.appName)}`, 302);
  });

  // The portal sent the browser back to the web app with ?token=…&appId=…; the web app posts both here.
  app.post("/api/auth/sso/exchange", async (request, reply) => {
    const portal = portalConfig();
    const body = exchangeBody.parse(request.body);
    const rejected = () => new AppError(401, "SSO_REJECTED", "Masuk lewat portal ditolak. Buka aplikasi ini lagi dari portal.");

    const identity = await verifyPortalToken(portal, body.token, body.appId);
    if (!identity) throw rejected();

    const now = context.now();
    const session = await orm.transaction(async (tx) => {
      const seen = { fullName: identity.fullName, employeeNo: identity.employeeNo, ssoProfile: identity.profile, lastLoginAt: now, updatedAt: now };
      const [existing] = await tx.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.ssoSubject, identity.subject));
      if (existing && !existing.isActive) return null;
      let userId = existing?.id;
      if (userId === undefined) {
        // First sign-in: the account starts without permissions; an admin grants them. When the email is already
        // the username of another account (a local one), the portal account gets its own username.
        const email = identity.email.toLowerCase();
        const [taken] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(sql`lower(${users.username})`, email));
        const [created] = await tx
          .insert(users)
          .values({ kind: "INTERNAL", username: taken ? `${email}#sso` : email, ssoSubject: identity.subject, ...seen })
          .returning({ id: users.id });
        userId = created?.id;
      } else {
        await tx.update(users).set(seen).where(eq(users.id, userId));
      }
      if (userId === undefined) return null;
      // the bootstrap admins get every active module again at each sign-in, so a module added later reaches them
      if (context.config.bootstrapAdminEmails.includes(identity.email.toLowerCase())) await grantEverything(tx, userId, now);
      const { accessToken } = await issueSession(context, tx, request, reply, userId);
      return { accessToken, user: await loadAccount(tx, userId) };
    });
    if (!session) throw rejected();
    return session;
  });
}
