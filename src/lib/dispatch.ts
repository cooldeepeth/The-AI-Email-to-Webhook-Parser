import { env } from "@/lib/env";
import { signPayload } from "@/lib/signature";

export interface OutboundSource {
  from: string | null;
  subject: string | null;
  message_id: string | null;
}

export interface BuildBodyArgs {
  endpointId: string;
  logId: string;
  receivedAt: string;
  source: OutboundSource;
  data: Record<string, unknown>;
}

/**
 * Deterministic outbound body. Built identically by the inbound route and
 * the retry worker so a retried delivery is byte-for-byte the original
 * (the signature timestamp is the only per-attempt difference).
 */
export function buildOutboundBody(args: BuildBodyArgs): string {
  return JSON.stringify({
    endpoint_id: args.endpointId,
    log_id: args.logId,
    received_at: args.receivedAt,
    source: args.source,
    data: args.data,
  });
}

export interface DeliveryResult {
  delivered: boolean;
  httpStatus: number | null;
  errorMessage: string | null;
}

/** Sign and POST the body to the developer's server with a hard timeout. */
export async function deliver(
  targetUrl: string,
  webhookSecret: string,
  logId: string,
  rawBody: string,
): Promise<DeliveryResult> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(webhookSecret, rawBody, timestamp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.webhookTimeoutMs);

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "thook-webhook/1.0",
        "x-thook-timestamp": timestamp,
        "x-thook-signature": signature,
        "x-thook-log-id": logId,
      },
      body: rawBody,
    });
    // Drain so the socket can be reused/closed cleanly.
    await res.text().catch(() => "");
    const delivered = res.status >= 200 && res.status < 300;
    return {
      delivered,
      httpStatus: res.status,
      errorMessage: delivered
        ? null
        : `developer server responded ${res.status}`,
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `timeout after ${env.webhookTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : "unknown delivery failure";
    return { delivered: false, httpStatus: null, errorMessage: message };
  } finally {
    clearTimeout(timer);
  }
}
