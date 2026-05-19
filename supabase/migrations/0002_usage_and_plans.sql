-- =====================================================================
-- thook - Usage metering & plan quotas
-- =====================================================================

-- New terminal outcome when an account is over its monthly quota.
alter type public.webhook_log_status add value if not exists 'quota_exceeded';

-- ---------------------------------------------------------------------
-- Plans & per-account billing config
-- ---------------------------------------------------------------------
create type public.plan_tier as enum ('free', 'pro', 'scale');

create table public.billing_accounts (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  plan           public.plan_tier not null default 'free',
  monthly_quota  integer not null default 100 check (monthly_quota >= 0),
  period_start   date not null default date_trunc('month', now())::date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger trg_billing_accounts_updated_at
  before update on public.billing_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Per-period usage counter (one row per account per calendar month)
-- ---------------------------------------------------------------------
create table public.usage_counters (
  user_id       uuid not null references auth.users (id) on delete cascade,
  period_start  date not null,
  parsed_count  integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (user_id, period_start)
);

create trigger trg_usage_counters_updated_at
  before update on public.usage_counters
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS: an account can read its own billing + usage. All writes happen
-- through the SECURITY DEFINER function below (service role).
-- ---------------------------------------------------------------------
alter table public.billing_accounts enable row level security;
alter table public.usage_counters   enable row level security;

create policy "billing_accounts_select_own"
  on public.billing_accounts for select
  using (auth.uid() = user_id);

create policy "usage_counters_select_own"
  on public.usage_counters for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- Atomic "check then count": lazily provisions a free account, rolls the
-- billing period on month change, rejects without incrementing when the
-- quota is reached, otherwise increments and returns the new total.
-- ---------------------------------------------------------------------
create or replace function public.record_usage_and_check(p_user_id uuid)
returns table (
  allowed       boolean,
  plan          public.plan_tier,
  monthly_quota integer,
  used          integer,
  period_start  date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan   public.plan_tier;
  v_quota  integer;
  v_period date := date_trunc('month', now())::date;
  v_used   integer;
begin
  insert into billing_accounts (user_id)
    values (p_user_id)
    on conflict (user_id) do nothing;

  select ba.plan, ba.monthly_quota
    into v_plan, v_quota
    from billing_accounts ba
    where ba.user_id = p_user_id;

  update billing_accounts
    set period_start = v_period
    where user_id = p_user_id and period_start <> v_period;

  select coalesce(uc.parsed_count, 0)
    into v_used
    from usage_counters uc
    where uc.user_id = p_user_id and uc.period_start = v_period;
  v_used := coalesce(v_used, 0);

  if v_used >= v_quota then
    return query select false, v_plan, v_quota, v_used, v_period;
    return;
  end if;

  insert into usage_counters (user_id, period_start, parsed_count)
    values (p_user_id, v_period, 1)
    on conflict (user_id, period_start)
    do update set parsed_count = usage_counters.parsed_count + 1
    returning usage_counters.parsed_count into v_used;

  return query select true, v_plan, v_quota, v_used, v_period;
end;
$$;

revoke all on function public.record_usage_and_check(uuid) from public, anon;
