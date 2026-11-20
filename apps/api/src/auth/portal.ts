// Client of the company portal's SSO check. The portal answers POST {PORTAL_API_URL}/sso/verify with
// { success: true, data: { id, email, isActive, employee: { nrk, nama, jabatan, grade, unit, … } } }, and a
// refused token with { success: false, error } and a 4xx status (portal-app-be: sso.route.ts, sso.service.ts).
import { z } from "zod";
import type { PortalConfig } from "../config.js";
import { AppError } from "../errors.js";

const part = z.record(z.string(), z.unknown()).nullish();

const verifyAnswer = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.string().min(1),
    email: z.string().min(1),
    isActive: z.literal(true),
    employee: z.object({
      nrk: z.string().nullish(),
      nama: z.string().min(1),
      jabatan: z.string().nullish(),
      grade: part,
      unit: part,
    }),
  }),
});

export interface PortalIdentity {
  /** The user's id at the portal. */
  subject: string;
  email: string;
  fullName: string;
  employeeNo: string | null;
  profile: { jabatan: string | null; unit: Record<string, unknown> | null; grade: Record<string, unknown> | null };
}

const pick = (source: Record<string, unknown> | null | undefined, keys: string[]) =>
  source ? Object.fromEntries(keys.map((key) => [key, source[key] ?? null])) : null;

/**
 * Exchanges the one-time token the portal handed to the browser. Null when the portal refuses it or the
 * user is not an active employee there; 502 when the portal gives no answer at all.
 */
export async function verifyPortalToken(portal: PortalConfig, token: string, appId: string): Promise<PortalIdentity | null> {
  let answer: unknown;
  try {
    const response = await fetch(`${portal.apiUrl}/sso/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, app_id: appId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    answer = await response.json();
  } catch {
    throw new AppError(502, "PORTAL_UNAVAILABLE", "Portal perusahaan tidak dapat dihubungi. Coba lagi sebentar.");
  }
  const parsed = verifyAnswer.safeParse(answer);
  if (!parsed.success) return null;
  const { id, email, employee } = parsed.data.data;
  return {
    subject: id,
    email,
    fullName: employee.nama,
    employeeNo: employee.nrk ?? null,
    profile: {
      jabatan: employee.jabatan ?? null,
      unit: pick(employee.unit, ["kode", "nama", "path"]),
      grade: pick(employee.grade, ["kode", "label", "level"]),
    },
  };
}
