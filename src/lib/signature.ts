import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 over the exact outbound body bytes. The developer verifies
 * this with their endpoint's `webhook_secret`. We sign
 * `${timestamp}.${body}` so a captured payload cannot be replayed with a
 * different timestamp without invalidating the signature.
 */
export function signPayload(
  secret: string,
  rawBody: string,
  timestamp: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

/** Constant-time comparison helper for receivers / tests. */
export function verifySignature(
  secret: string,
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  const expected = signPayload(secret, rawBody, timestamp);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
