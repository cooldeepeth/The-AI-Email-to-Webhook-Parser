/**
 * Single source of truth for the (deliberately tiny) plan matrix.
 *
 * Pricing page shows exactly three choices: self-host (free, OSS),
 * Hosted Free, Hosted Pro. Only the two hosted plans live in the DB
 * `plan_tier` enum; `scale` is reserved for a future negotiated tier and
 * is intentionally not surfaced in the UI.
 */
export type HostedPlan = "free" | "pro";

export const PLAN_QUOTA: Record<HostedPlan, number> = {
  free: 100,
  pro: 3000,
};

export const PRO_PRICE_USD = 29;
