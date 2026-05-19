import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Defaults shown before the account is lazily provisioned on first email.
const DEFAULT_PLAN = "free";
const DEFAULT_QUOTA = 100;

function currentPeriodStart(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// GET /api/v1/usage — current plan, quota, and month-to-date usage.
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const period = currentPeriodStart();

  const [{ data: account, error: accErr }, { data: counter, error: cntErr }] =
    await Promise.all([
      auth.ctx.supabase
        .from("billing_accounts")
        .select("plan,monthly_quota,period_start")
        .maybeSingle(),
      auth.ctx.supabase
        .from("usage_counters")
        .select("parsed_count,period_start")
        .eq("period_start", period)
        .maybeSingle(),
    ]);

  if (accErr || cntErr) {
    return NextResponse.json(
      { ok: false, error: "query_failed" },
      { status: 500 },
    );
  }

  const plan = account?.plan ?? DEFAULT_PLAN;
  const monthlyQuota = account?.monthly_quota ?? DEFAULT_QUOTA;
  const used = counter?.parsed_count ?? 0;

  return NextResponse.json({
    ok: true,
    usage: {
      plan,
      monthly_quota: monthlyQuota,
      used,
      remaining: Math.max(monthlyQuota - used, 0),
      period_start: period,
    },
  });
}
