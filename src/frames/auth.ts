/** Manager-private authentication for cross-frame port admission. */

const encoder = new TextEncoder();
const ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

const encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const decode = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const key = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    ALGORITHM,
    false,
    ["sign", "verify"],
  );

const payload = (
  token: string,
  helloId: string,
): Uint8Array<ArrayBuffer> => encoder.encode(`${token}:${helloId}`);

/** Create the persistent credential shared through manager-private storage. */
export const createFrameSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encode(bytes);
};

/** Prove that this frame can read the userscript manager's private storage. */
export const signFrameJoin = async (
  secret: string,
  token: string,
  helloId: string,
): Promise<string> => {
  if (secret.length === 0) throw new Error("frame credential is unavailable");
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    await key(secret),
    payload(token, helloId),
  );
  return encode(new Uint8Array(signature));
};

/** Verify a one-shot challenge response without exposing the credential. */
export const verifyFrameJoin = async (
  secret: string,
  token: string,
  helloId: string,
  proof: string,
): Promise<boolean> => {
  if (secret.length === 0) return false;
  try {
    return await crypto.subtle.verify(
      ALGORITHM,
      await key(secret),
      decode(proof),
      payload(token, helloId),
    );
  } catch {
    return false;
  }
};
