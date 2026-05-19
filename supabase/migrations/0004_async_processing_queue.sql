-- =====================================================================
-- thook - Asynchronous inbound processing queue
-- =====================================================================
-- The inbound route now only persists the raw payload as 'pending' and
-- returns 200 immediately (no synchronous LLM / dispatch — those blew
-- past the serverless timeout). A cron worker drains the queue.

-- 'pending'  : raw email stored, awaiting AI parse + dispatch.
-- 'processing': claimed by a worker (in flight). Reused for the AI stage.
alter type public.webhook_log_status add value if not exists 'pending';

-- When set, the row is an AI-stage retry and must not be re-claimed until
-- this time. NULL means "process as soon as possible" (fresh inbound).
alter table public.webhook_logs
  add column if not exists next_retry_at timestamptz;

-- Hot path for the claim query. Text-cast predicate so this migration
-- never references the just-added enum value in a stored expression
-- within its own transaction (Postgres rejects that).
create index if not exists idx_webhook_logs_queue
  on public.webhook_logs (created_at)
  where status::text in ('pending', 'processing');

-- ---------------------------------------------------------------------
-- Atomically claim a batch of work. FOR UPDATE SKIP LOCKED makes this
-- safe when cron runs overlap. Also reclaims rows stuck in 'processing'
-- longer than p_stale_minutes (a worker that crashed mid-batch), so the
-- queue is self-healing without any external infrastructure.
-- ---------------------------------------------------------------------
create or replace function public.claim_pending_logs(
  p_limit         integer,
  p_stale_minutes integer default 5
)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update webhook_logs
    set status = 'processing'
    where id in (
      select id
        from webhook_logs
        where (
          status::text = 'pending'
          and (next_retry_at is null or next_retry_at <= now())
        )
        or (
          status::text = 'processing'
          and updated_at < now() - make_interval(mins => p_stale_minutes)
        )
        order by created_at asc
        limit p_limit
        for update skip locked
    )
    returning id;
end;
$$;

revoke all on function public.claim_pending_logs(integer, integer)
  from public, anon;
