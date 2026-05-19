import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export interface AuthedContext {
  supabase: SupabaseClient;
  userId: string;
}

type AuthOutcome =
  | { ok: true; ctx: AuthedContext }
  | { ok: false; response: NextResponse };

/**
 * Authenticate a request via a Supabase user JWT (Authorization: Bearer).
 *
 * The returned client carries the caller's token, so every query runs
 * under the owner-scoped RLS policies from the migration — the API layer
 * does not re-implement authorization, it relies on the database.
 */
export async function authenticate(req: NextRequest): Promise<AuthOutcome> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "missing_bearer_token" },
        { status: 401 },
      ),
    };
  }
  const token = auth.slice(7).trim();

  let supabase: SupabaseClient;
  try {
    supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "server_misconfigured" },
        { status: 500 },
      ),
    };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "invalid_or_expired_token" },
        { status: 401 },
      ),
    };
  }

  return { ok: true, ctx: { supabase, userId: data.user.id } };
}
