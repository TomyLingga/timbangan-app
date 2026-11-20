// The company portal sends the browser back with `?token=…&appId=…`. The app
// is registered there with its root URL, so the pair arrives on `/`; the
// callback page `/auth/sso` accepts the same query when opened directly.

export const SSO_CALLBACK_PATH = "/auth/sso";

export interface SsoTicket {
  token: string;
  appId: string;
}

export function readSsoTicket(search: string): SsoTicket | null {
  const params = new URLSearchParams(search);
  const token = params.get("token");
  const appId = params.get("appId");
  return token && appId ? { token, appId } : null;
}

/**
 * Where to send the browser when a route other than the callback page receives
 * a ticket, or null when there is nothing to forward.
 */
export function ssoForwardTarget(pathname: string, search: string): string | null {
  if (pathname === SSO_CALLBACK_PATH) return null;
  const ticket = readSsoTicket(search);
  if (!ticket) return null;
  const query = new URLSearchParams({ token: ticket.token, appId: ticket.appId });
  return `${SSO_CALLBACK_PATH}?${query.toString()}`;
}
