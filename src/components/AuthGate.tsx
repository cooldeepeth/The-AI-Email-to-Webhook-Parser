"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase-browser";

/** Redirects to /login when there is no active session. */
export default function AuthGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "authed">("checking");

  useEffect(() => {
    const supabase = getBrowserClient();
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) setState("authed");
      else router.replace("/login");
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!active) return;
      if (session) setState("authed");
      else router.replace("/login");
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  if (state === "checking") {
    return (
      <div className="wrap">
        <p className="muted">Loading…</p>
      </div>
    );
  }
  return <>{children}</>;
}

export async function signOut() {
  await getBrowserClient().auth.signOut();
}
