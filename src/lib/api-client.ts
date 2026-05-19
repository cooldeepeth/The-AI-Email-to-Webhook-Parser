"use client";

import { getBrowserClient } from "@/lib/supabase-browser";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * fetch wrapper that attaches the current Supabase access token. The API
 * routes enforce ownership via RLS, so this only needs to forward the JWT.
 */
export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const supabase = getBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new ApiError(401, "not_authenticated");

  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
      authorization: `Bearer ${session.access_token}`,
    },
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty / non-JSON body */
  }

  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `request_failed_${res.status}`;
    throw new ApiError(res.status, err);
  }
  return body as T;
}
