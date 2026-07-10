import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time compare of two secrets of arbitrary length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hashing first gives fixed-width inputs.
  const ah = createHmac("sha256", "shoebox-compare").update(ab).digest();
  const bh = createHmac("sha256", "shoebox-compare").update(bb).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * A session token is `<scope>.<expiresAtMs>.<hmac>`.
 * `scope` is either "all" (full access, granted by the password) or a bundle id
 * (granted by that bundle's secret link). The scope is inside the signature, so
 * a bundle token cannot be replayed against another bundle.
 */
export function signToken(scope: string, expiresAtMs: number, secret: string): string {
  const body = `${scope}.${expiresAtMs}`;
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): { scope: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [scope, expRaw, sig] = parts as [string, string, string];

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return null;

  const expected = createHmac("sha256", secret).update(`${scope}.${expRaw}`).digest("base64url");
  if (!safeEqual(sig, expected)) return null;

  return { scope };
}
