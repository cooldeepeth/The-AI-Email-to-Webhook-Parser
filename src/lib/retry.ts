import { env } from "@/lib/env";

/**
 * Backoff schedule (minutes) indexed by the number of attempts already
 * made. A failed delivery becomes eligible for re-attempt once at least
 * `backoffMinutes[retry_count]` have elapsed since its last update.
 * The last value is reused for any attempt beyond the array length.
 */
export function backoffDelayMs(retryCount: number): number {
  const schedule = env.retryBackoffMinutes;
  const idx = Math.min(retryCount, schedule.length - 1);
  return schedule[idx] * 60_000;
}

export function isEligible(retryCount: number, updatedAt: string): boolean {
  if (retryCount >= env.maxDeliveryRetries) return false;
  const elapsed = Date.now() - new Date(updatedAt).getTime();
  return elapsed >= backoffDelayMs(retryCount);
}
