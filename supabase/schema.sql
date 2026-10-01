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
  image_key   text,
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

-- Safe migrations for databases created before image references and saved addresses existed.
alter table products add column if not exists image_key text;
