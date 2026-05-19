import { randomBytes } from "node:crypto";

/** Must match the CHECK constraint on endpoints.inbound_email_slug. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

/** 16 lowercase hex chars — always satisfies SLUG_RE. */
export function generateSlug(): string {
  return randomBytes(8).toString("hex");
}

/** Matches the column default style: 64 hex chars. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
