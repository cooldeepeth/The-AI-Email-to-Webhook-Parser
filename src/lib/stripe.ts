import Stripe from "stripe";
import { env } from "@/lib/env";

/**
 * Lazily-constructed Stripe client. Server-only — the secret key must
 * never reach the browser. Mirrors the supabase service client pattern.
 */
let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  cached = new Stripe(env.stripeSecretKey, { apiVersion: "2025-02-24.acacia" });
  return cached;
}
