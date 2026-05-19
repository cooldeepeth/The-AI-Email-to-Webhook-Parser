-- =====================================================================
-- thook - Initial schema
-- AI-powered inbound email-to-webhook parser
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_organizations_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- profiles  (links Supabase auth.users -> organization)
-- ---------------------------------------------------------------------
create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  email           text,
  full_name       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- endpoints
-- ---------------------------------------------------------------------
create table public.endpoints (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  organization_id     uuid references public.organizations (id) on delete cascade,
  name                text not null,
  inbound_email_slug  text not null unique
                        check (inbound_email_slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  target_webhook_url  text not null
                        check (target_webhook_url ~* '^https?://'),
  webhook_secret      text not null default encode(gen_random_bytes(32), 'hex'),
  ai_prompt_schema    text not null,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_endpoints_user_id on public.endpoints (user_id);
create index idx_endpoints_slug_active
  on public.endpoints (inbound_email_slug) where is_active;

create trigger trg_endpoints_updated_at
  before update on public.endpoints
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- webhook_logs
-- ---------------------------------------------------------------------
create type public.webhook_log_status as enum (
  'received',
  'processing',
  'success',
  'failed_ai',
  'failed_delivery'
);

create table public.webhook_logs (
  id                  uuid primary key default gen_random_uuid(),
  endpoint_id         uuid references public.endpoints (id) on delete cascade,
  status              public.webhook_log_status not null default 'received',
  raw_email_payload   jsonb,
  parsed_json_output  jsonb,
  http_response_code  integer,
  retry_count         integer not null default 0,
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_webhook_logs_endpoint_created
  on public.webhook_logs (endpoint_id, created_at desc);
create index idx_webhook_logs_status on public.webhook_logs (status);

create trigger trg_webhook_logs_updated_at
  before update on public.webhook_logs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
--
-- The inbound API route uses the Supabase SERVICE ROLE key, which
-- bypasses RLS. These policies protect data when accessed with an
-- end-user session (the future dashboard).
-- ---------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.profiles      enable row level security;
alter table public.endpoints     enable row level security;
alter table public.webhook_logs  enable row level security;

-- profiles: a user can read/update only their own profile row.
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- organizations: members can read their own organization.
create policy "organizations_select_member"
  on public.organizations for select
  using (
    id in (
      select organization_id from public.profiles where id = auth.uid()
    )
  );

-- endpoints: owner-scoped full access.
create policy "endpoints_select_own"
  on public.endpoints for select
  using (auth.uid() = user_id);

create policy "endpoints_insert_own"
  on public.endpoints for insert
  with check (auth.uid() = user_id);

create policy "endpoints_update_own"
  on public.endpoints for update
  using (auth.uid() = user_id);

create policy "endpoints_delete_own"
  on public.endpoints for delete
  using (auth.uid() = user_id);

-- webhook_logs: readable by the owner of the parent endpoint.
-- Writes happen exclusively via the service role (RLS bypassed).
create policy "webhook_logs_select_own"
  on public.webhook_logs for select
  using (
    endpoint_id in (
      select id from public.endpoints where user_id = auth.uid()
    )
  );
