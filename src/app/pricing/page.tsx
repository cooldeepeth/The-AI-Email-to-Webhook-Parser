"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase-browser";
import { PRO_PRICE_USD, PLAN_QUOTA } from "@/lib/plans";

const GITHUB_URL =
  "https://github.com/cooldeepeth/the-ai-email-to-webhook-parser";

export default function PricingPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upgrade() {
    setBusy(true);
    setErr(null);
    try {
      const supabase = getBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }
      const res = await fetch("/api/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      const body = await res.json();
      if (!res.ok || !body.url) {
        throw new Error(body.error ?? `checkout_failed_${res.status}`);
      }
      window.location.href = body.url as string;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start checkout");
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">thook</div>
        <Link href="/">Dashboard →</Link>
      </div>

      <h1>Simple pricing</h1>
      <p className="muted" style={{ marginTop: -8, marginBottom: 24 }}>
        AI email-to-webhook parsing with signed delivery and automatic
        retries. Cheaper per parse than template-based tools — or run it
        yourself for free.
      </p>

      <div className="cards">
        <div className="card">
          <h3>Self-host</h3>
          <div className="price">Free</div>
          <p className="muted">Open source (AGPL). The full engine.</p>
          <ul>
            <li>Unlimited parses (your infra)</li>
            <li>Signed webhooks + auto-retry</li>
            <li>Bring your own AI key</li>
          </ul>
          <a className="cardbtn secondary" href={GITHUB_URL}>
            View on GitHub
          </a>
        </div>

        <div className="card">
          <h3>Hosted Free</h3>
          <div className="price">$0</div>
          <p className="muted">Zero-setup, fully managed.</p>
          <ul>
            <li>{PLAN_QUOTA.free} parses / month</li>
            <li>Signed webhooks + auto-retry</li>
            <li>Managed inbound + AI included</li>
          </ul>
          <Link className="cardbtn secondary" href="/login">
            Start free
          </Link>
        </div>

        <div className="card featured">
          <h3>Hosted Pro</h3>
          <div className="price">
            ${PRO_PRICE_USD}
            <span className="per">/mo</span>
          </div>
          <p className="muted">For production workloads.</p>
          <ul>
            <li>{PLAN_QUOTA.pro.toLocaleString()} parses / month</li>
            <li>Everything in Free</li>
            <li>Priority delivery + AI included</li>
          </ul>
          <button className="cardbtn" onClick={upgrade} disabled={busy}>
            {busy ? "Redirecting…" : "Upgrade"}
          </button>
        </div>
      </div>

      {err && <p className="error">{err}</p>}
    </div>
  );
}
