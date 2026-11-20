import { hash, verify } from "@node-rs/argon2";

/** argon2id with the library defaults (19 MiB, 2 passes), encoded as a PHC string. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** False for a wrong password and for a stored value that is not an argon2 hash. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
