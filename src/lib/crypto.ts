import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function hmac(secret: string, value: string): string {
  return b64url(createHmac("sha256", secret).update(value).digest());
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** "<value>.<signature>" */
export function sign(secret: string, value: string): string {
  return `${value}.${hmac(secret, value)}`;
}

export function unsign(secret: string, token: string): string | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const value = token.slice(0, i);
  return safeEqual(token.slice(i + 1), hmac(secret, value)) ? value : null;
}

/** Any long random string works: it is hashed to a 32-byte key. */
function keyFrom(secret: string): Buffer {
  if (secret.length < 24) throw new Error("ENCRYPTION_KEY must be a random string of at least 24 characters");
  return createHash("sha256").update(secret).digest();
}

/** AES-256-GCM. Output: iv.tag.ciphertext, each base64url. */
export function encrypt(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b64url).join(".");
}

export function decrypt(secret: string, payload: string): string {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
