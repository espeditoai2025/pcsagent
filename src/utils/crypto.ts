import crypto from "crypto";

/**
 * Cifratura simmetrica AES-256-GCM per i segreti a riposo (es. token Facebook).
 * La chiave arriva da ENCRYPTION_KEY (64 caratteri hex = 32 byte) e DEVE essere
 * identica sul backend (VPS) e sul frontend (Vercel) per poter decifrare ovunque.
 *
 * Formato output: "v1:" + base64(iv[12] | authTag[16] | ciphertext)
 */

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!raw) throw new Error("ENCRYPTION_KEY mancante");
  // Accetta hex (64 char) o base64; fallback: hash della stringa per ottenere 32 byte
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1:" + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(payload: string | null | undefined): string {
  if (!payload) return "";
  if (!payload.startsWith("v1:")) {
    // Valore non cifrato (legacy / inserito a mano): restituiscilo cosi com'e.
    return payload;
  }
  const raw = Buffer.from(payload.slice(3), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** True se la stringa e gia in formato cifrato v1. */
export function isEncrypted(value: string | null | undefined): boolean {
  return !!value && value.startsWith("v1:");
}
