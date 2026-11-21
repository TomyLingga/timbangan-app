// The web build is for development and screenshots: there is no device lock to ask, so the check passes.

export type DeviceAuthResult = { ok: true } | { ok: false; message: string };

export async function confirmIdentity(_prompt: string): Promise<DeviceAuthResult> {
  return { ok: true };
}
