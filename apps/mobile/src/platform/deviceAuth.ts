// Identity check right before a decision is sent: fingerprint or face, or the phone PIN/pattern as fallback.
// A phone without any screen lock cannot confirm who holds it, so the decision is not sent.

import * as LocalAuthentication from "expo-local-authentication";

export type DeviceAuthResult = { ok: true } | { ok: false; message: string };

export async function confirmIdentity(prompt: string): Promise<DeviceAuthResult> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) {
    return { ok: false, message: "Ponsel ini belum punya kunci layar. Pasang PIN atau sidik jari dulu." };
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: prompt,
    cancelLabel: "Batal",
    disableDeviceFallback: false,
  });
  if (result.success) return { ok: true };
  if (result.error === "user_cancel" || result.error === "system_cancel" || result.error === "app_cancel") {
    return { ok: false, message: "Pengecekan identitas dibatalkan. Keputusan belum dikirim." };
  }
  return { ok: false, message: "Identitas tidak bisa dipastikan. Keputusan belum dikirim." };
}
