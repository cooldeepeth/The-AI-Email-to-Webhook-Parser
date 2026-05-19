/**
 * Centralised, lazily-validated environment access.
 *
 * We intentionally do NOT throw at module load time so that `next build`
 * (which evaluates route modules) does not fail when secrets are absent.
 * Each value is validated on first use inside the request lifecycle.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export const env = {
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },

  /** Public anon key — used with the caller's JWT so RLS is enforced. */
  get supabaseAnonKey() {
    return required("SUPABASE_ANON_KEY");
  },

  /** Shared secret Postmark must present (HTTP Basic password or ?token=). */
  get postmarkInboundToken() {
    return required("POSTMARK_INBOUND_WEBHOOK_TOKEN");
  },

  /**
   * Optional inbound domain (e.g. "inbound.thook.io"). When set, the
   * recipient on that domain is used to resolve the slug, which makes
   * forwarded / multi-recipient emails unambiguous.
   */
  get inboundEmailDomain(): string | null {
    const v = process.env.INBOUND_EMAIL_DOMAIN;
    return v && v.trim() !== "" ? v.trim().toLowerCase() : null;
  },

  /** "anthropic" | "openai" */
  get aiProvider(): "anthropic" | "openai" {
    const p = optional("AI_PROVIDER", "anthropic").toLowerCase();
    return p === "openai" ? "openai" : "anthropic";
  },
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get anthropicModel() {
    return optional("ANTHROPIC_MODEL", "claude-sonnet-4-6");
  },
  get openaiApiKey() {
    return required("OPENAI_API_KEY");
  },
  get openaiModel() {
    return optional("OPENAI_MODEL", "gpt-4o-mini");
  },

  /** Bound the LLM and outbound-webhook calls so a route never hangs. */
  get aiTimeoutMs() {
    return Number(optional("AI_TIMEOUT_MS", "45000"));
  },
  get webhookTimeoutMs() {
    return Number(optional("WEBHOOK_TIMEOUT_MS", "15000"));
  },

  /** Shared secret for the cron retry worker and manual replay routes. */
  get cronSecret() {
    return required("CRON_SECRET");
  },
  get maxDeliveryRetries() {
    return Number(optional("MAX_DELIVERY_RETRIES", "5"));
  },
  /** Per-attempt backoff in minutes, indexed by retry_count. */
  get retryBackoffMinutes(): number[] {
    const raw = optional("RETRY_BACKOFF_MINUTES", "1,5,15,60,180");
    const parsed = raw
      .split(",")
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
    return parsed.length > 0 ? parsed : [1, 5, 15, 60, 180];
  },
  /** Max logs processed per cron invocation. */
  get retryBatchSize() {
    return Number(optional("RETRY_BATCH_SIZE", "25"));
  },

  // --- Stripe billing ---
  get stripeSecretKey() {
    return required("STRIPE_SECRET_KEY");
  },
  /** Endpoint signing secret from the Stripe webhook dashboard. */
  get stripeWebhookSecret() {
    return required("STRIPE_WEBHOOK_SECRET");
  },
  /** Recurring Price id for Hosted Pro ($29/mo). */
  get stripeProPriceId() {
    return required("STRIPE_PRO_PRICE_ID");
  },
  /**
   * Absolute base URL for Checkout/Portal return links. Optional — the
   * request origin is used when unset (correct for single-domain deploys).
   */
  get appUrl(): string | null {
    const v = process.env.APP_URL;
    return v && v.trim() !== "" ? v.trim().replace(/\/+$/, "") : null;
  },
} as const;
