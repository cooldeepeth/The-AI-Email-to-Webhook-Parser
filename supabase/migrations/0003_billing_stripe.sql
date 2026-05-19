-- =====================================================================
-- thook - Stripe billing linkage
-- =====================================================================
-- Adds the Stripe customer/subscription handles to each billing account
-- and a single SECURITY DEFINER entry point the Stripe webhook uses to
-- move an account between plans. Plan/quota still live in the DB so the
-- inbound quota check (record_usage_and_check) needs no changes.

alter table public.billing_accounts
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text;

create unique index if not exists billing_accounts_stripe_customer_id_key
  on public.billing_accounts (stripe_customer_id)
  where stripe_customer_id is not null;

-- ---------------------------------------------------------------------
-- Apply a plan change. Idempotent: the Stripe webhook may deliver the
-- same event more than once, so this only ever sets the target state.
-- Lazily provisions the row (mirrors record_usage_and_check) so a
-- checkout completing before the first inbound email still works.
-- ---------------------------------------------------------------------
create or replace function public.set_account_plan(
  p_user_id         uuid,
  p_plan            public.plan_tier,
  p_quota           integer,
  p_customer_id     text default null,
  p_subscription_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into billing_accounts (user_id, plan, monthly_quota)
    values (p_user_id, p_plan, p_quota)
    on conflict (user_id) do update
      set plan          = excluded.plan,
          monthly_quota = excluded.monthly_quota;

  update billing_accounts
    set stripe_customer_id     = coalesce(p_customer_id, stripe_customer_id),
        stripe_subscription_id = case
          when p_plan = 'free' then null
          else coalesce(p_subscription_id, stripe_subscription_id)
        end
    where user_id = p_user_id;
end;
$$;

revoke all on function
  public.set_account_plan(uuid, public.plan_tier, integer, text, text)
  from public, anon;
