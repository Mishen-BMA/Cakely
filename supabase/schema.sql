-- Cakely database schema for Supabase
-- Run this once in the Supabase Dashboard: SQL Editor -> New query -> paste -> Run

create table if not exists users (
  id            bigint generated always as identity primary key,
  username      varchar(80) unique not null,
  email         varchar(160) unique not null,
  password_hash text not null,
  is_admin      boolean not null default false,
  rate_limited_until timestamptz,
  created_at    timestamptz not null default now()
);

alter table users add column if not exists rate_limited_until timestamptz;

create table if not exists platform_settings (
  id integer primary key check (id = 1),
  rulelock_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into platform_settings (id, rulelock_enabled) values (1, false) on conflict (id) do nothing;

create table if not exists products (
  id          bigint generated always as identity primary key,
  name        varchar(160) not null,
  slug        varchar(180) unique not null,
  description text not null,
  category    varchar(80) not null,
  base_price  numeric(10, 2) not null,
  image       text not null,
  flavours    jsonb not null default '[]',
  sizes       jsonb not null default '{}',
  active      boolean not null default true
);

create table if not exists addresses (
  id           bigint generated always as identity primary key,
  user_id      bigint not null references users(id) on delete cascade,
  label        varchar(60) not null default 'Home',
  recipient    varchar(120) not null,
  phone        varchar(40) not null,
  address      text not null,
  city         varchar(80) not null,
  district     varchar(80) not null,
  postal_code  varchar(20),
  is_default   boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists orders (
  id             bigint generated always as identity primary key,
  order_number   varchar(30) unique not null,
  user_id        bigint references users(id),
  items          jsonb not null,
  address        jsonb not null,
  payment_method varchar(30) not null,
  payment_status varchar(30) not null default 'PENDING',
  status         varchar(30) not null default 'PENDING',
  subtotal       numeric(10, 2) not null,
  discount       numeric(10, 2) not null default 0,
  delivery_fee   numeric(10, 2) not null default 350,
  total          numeric(10, 2) not null,
  created_at     timestamptz not null default now()
);

create table if not exists transaction_events (
  id         bigint generated always as identity primary key,
  event_id   varchar(40) unique not null,
  event_type varchar(60) not null,
  user_id    bigint,
  order_id   bigint,
  metadata   jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Existing projects created before event metadata was introduced need this
-- idempotent migration; CREATE TABLE IF NOT EXISTS does not add new columns.
alter table transaction_events
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists coupons (
  id              bigint generated always as identity primary key,
  code            varchar(40) unique not null,
  description     varchar(255),
  discount_type   varchar(30) not null default 'PERCENTAGE',
  discount_value  numeric(10, 2) not null default 0,
  minimum_order   numeric(10, 2) not null default 0,
  max_discount    numeric(10, 2),
  usage_limit     integer,
  per_user_limit  integer,
  allowed_payment_methods text[] not null default '{}'::text[],
  expires_at      timestamptz,
  can_stack       boolean not null default false,
  first_order_only boolean not null default false,
  free_delivery   boolean not null default false,
  cod_applicable  boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table if not exists coupon_usages (
  id         bigint generated always as identity primary key,
  coupon_id  bigint not null references coupons(id),
  user_id    bigint,
  order_id   bigint,
  created_at timestamptz not null default now()
);

create unique index if not exists coupon_usages_one_per_coupon_order
  on coupon_usages (coupon_id, order_id)
  where order_id is not null;

create or replace function public.record_coupon_usages(
  p_coupon_ids bigint[],
  p_user_id bigint,
  p_order_id bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  coupon_row coupons%rowtype;
  requested_count integer;
  locked_count integer := 0;
  total_count bigint;
  user_count bigint;
begin
  if p_order_id is null or p_user_id is null then
    raise exception using errcode = '22004', message = 'coupon_usage_requires_user_and_order';
  end if;

  select count(distinct coupon_id)::integer into requested_count
  from unnest(coalesce(p_coupon_ids, array[]::bigint[])) as coupon_id;
  if requested_count = 0 then return; end if;

  for coupon_row in
    select * from coupons
    where id = any(coalesce(p_coupon_ids, array[]::bigint[]))
    order by id
    for update
  loop
    locked_count := locked_count + 1;
    if not coupon_row.active then
      raise exception using errcode = 'P0001', message = 'coupon_no_longer_active';
    end if;

    if coupon_row.usage_limit is not null and coupon_row.usage_limit > 0 then
      select count(*) into total_count from coupon_usages where coupon_id = coupon_row.id;
      if total_count >= coupon_row.usage_limit then
        raise exception using errcode = 'P0001', message = 'coupon_usage_limit_reached';
      end if;
    end if;

    if coupon_row.per_user_limit is not null and coupon_row.per_user_limit > 0 then
      select count(*) into user_count from coupon_usages
      where coupon_id = coupon_row.id and user_id = p_user_id;
      if user_count >= coupon_row.per_user_limit then
        raise exception using errcode = 'P0001', message = 'coupon_user_usage_limit_reached';
      end if;
    end if;

    insert into coupon_usages (coupon_id, user_id, order_id)
    values (coupon_row.id, p_user_id, p_order_id);
  end loop;

  if locked_count <> requested_count then
    raise exception using errcode = 'P0001', message = 'coupon_not_found';
  end if;
end;
$$;

revoke all on function public.record_coupon_usages(bigint[], bigint, bigint) from public, anon, authenticated;
grant execute on function public.record_coupon_usages(bigint[], bigint, bigint) to service_role;

create or replace function public.admin_dashboard_metrics()
returns table (
  order_count bigint,
  pending_count bigint,
  preparing_count bigint,
  completed_count bigint,
  revenue numeric,
  customer_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (where status = 'PENDING')::bigint,
    count(*) filter (where status = 'PREPARING')::bigint,
    count(*) filter (where status = 'COMPLETED')::bigint,
    coalesce(sum(total), 0)::numeric,
    (select count(*) from users where is_admin = false)::bigint
  from orders;
$$;

create or replace function public.admin_dashboard_customer_stats(p_user_ids bigint[])
returns table (user_id bigint, orders bigint, spending numeric)
language sql
stable
security definer
set search_path = public
as $$
  select o.user_id, count(*)::bigint, coalesce(sum(o.total), 0)::numeric
  from orders o
  where o.user_id = any(coalesce(p_user_ids, array[]::bigint[]))
  group by o.user_id;
$$;

revoke all on function public.admin_dashboard_metrics() from public, anon, authenticated;
revoke all on function public.admin_dashboard_customer_stats(bigint[]) from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics() to service_role;
grant execute on function public.admin_dashboard_customer_stats(bigint[]) to service_role;

-- Row Level Security: lock every table down completely.
-- The backend only ever talks to Supabase using the SECRET key, which
-- bypasses RLS entirely, so the public/publishable key can never read or
-- write anything here even though the tables technically exist.
alter table users enable row level security;
alter table products enable row level security;
alter table addresses enable row level security;
alter table orders enable row level security;
alter table transaction_events enable row level security;
alter table coupons enable row level security;
alter table coupon_usages enable row level security;
alter table platform_settings enable row level security;

-- No policies are created on purpose: with RLS on and zero policies,
-- anon/publishable-key access is denied by default.

-- Explicit grants are required for projects where the SQL editor creates
-- tables under a role other than service_role. RLS still blocks public access;
-- the backend secret key uses service_role and needs these privileges.
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

-- Safe migrations for databases created before saved addresses existed.
