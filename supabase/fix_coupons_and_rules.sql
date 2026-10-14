-- ============================================================================
-- Fix Coupons Table, Stored Procedure, and Seed Initial Coupons
-- Run this in Supabase Dashboard -> SQL Editor -> New Query -> Run
-- ============================================================================

-- 1. Ensure all columns exist on the coupons table
alter table public.coupons 
  add column if not exists allowed_payment_methods text[] not null default '{}'::text[],
  add column if not exists discount_type varchar(30) not null default 'PERCENTAGE',
  add column if not exists discount_value numeric(10, 2) not null default 0,
  add column if not exists minimum_order numeric(10, 2) not null default 0,
  add column if not exists max_discount numeric(10, 2),
  add column if not exists usage_limit integer,
  add column if not exists per_user_limit integer,
  add column if not exists expires_at timestamptz,
  add column if not exists can_stack boolean not null default false,
  add column if not exists first_order_only boolean not null default false,
  add column if not exists free_delivery boolean not null default false,
  add column if not exists cod_applicable boolean not null default true,
  add column if not exists active boolean not null default true,
  add column if not exists created_at timestamptz not null default now();

-- Copy legacy column values if they exist
do $$
begin
  if exists (select 1 from information_schema.columns where table_name='coupons' and column_name='value') then
    update public.coupons set discount_value = value where discount_value = 0 and value is not null;
  end if;
  if exists (select 1 from information_schema.columns where table_name='coupons' and column_name='min_spend') then
    update public.coupons set minimum_order = min_spend where minimum_order = 0 and min_spend is not null;
  end if;
end $$;

-- 2. Create coupon_usages table for atomic tracking and double-spend prevention
create table if not exists public.coupon_usages (
  id bigint generated always as identity primary key,
  coupon_id bigint not null references public.coupons(id),
  user_id bigint,
  order_id bigint,
  created_at timestamptz not null default now()
);

create unique index if not exists coupon_usages_one_per_coupon_order
  on public.coupon_usages (coupon_id, order_id)
  where order_id is not null;

-- Enable RLS on coupon_usages
alter table public.coupon_usages enable row level security;
grant usage on schema public to service_role;
grant all privileges on table public.coupon_usages to service_role;

-- 3. Stored procedure to atomically record coupon usage and enforce limits
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
  coupon_row public.coupons%rowtype;
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
    select * from public.coupons
    where id = any(coalesce(p_coupon_ids, array[]::bigint[]))
    order by id
    for update
  loop
    locked_count := locked_count + 1;
    if not coupon_row.active then
      raise exception using errcode = 'P0001', message = 'coupon_no_longer_active';
    end if;

    if coupon_row.usage_limit is not null and coupon_row.usage_limit > 0 then
      select count(*) into total_count from public.coupon_usages where coupon_id = coupon_row.id;
      if total_count >= coupon_row.usage_limit then
        raise exception using errcode = 'P0001', message = 'coupon_usage_limit_reached';
      end if;
    end if;

    if coupon_row.per_user_limit is not null and coupon_row.per_user_limit > 0 then
      select count(*) into user_count from public.coupon_usages
      where coupon_id = coupon_row.id and user_id = p_user_id;
      if user_count >= coupon_row.per_user_limit then
        raise exception using errcode = 'P0001', message = 'coupon_user_usage_limit_reached';
      end if;
    end if;

    insert into public.coupon_usages (coupon_id, user_id, order_id)
    values (coupon_row.id, p_user_id, p_order_id);
  end loop;

  if locked_count <> requested_count then
    raise exception using errcode = 'P0001', message = 'coupon_not_found';
  end if;
end;
$$;

revoke all on function public.record_coupon_usages(bigint[], bigint, bigint) from public, anon, authenticated;
grant execute on function public.record_coupon_usages(bigint[], bigint, bigint) to service_role;

-- 4. Seed and update standard coupons
insert into public.coupons (code, description, discount_type, discount_value, minimum_order, allowed_payment_methods, first_order_only, per_user_limit, free_delivery, cod_applicable, can_stack, active)
values
  ('CAKE10', '10% off your cake order', 'PERCENTAGE', 10, 0, array['CARD', 'COD']::text[], false, null, false, true, false, true),
  ('CAKE20', '20% off your cake order', 'PERCENTAGE', 20, 0, array['CARD', 'COD']::text[], false, null, false, true, false, true),
  ('CAKE30', '30% off your cake order', 'PERCENTAGE', 30, 0, array['COD']::text[], false, null, false, true, false, true),
  ('CAKE50', '50% off your cake order', 'PERCENTAGE', 50, 0, array['CARD']::text[], false, null, false, false, false, true),
  ('SAVE500', 'Rs. 500 off orders over Rs. 2500', 'FIXED', 500, 2500, array['COD']::text[], false, null, false, true, false, true),
  ('FIRSTCAKE', 'Rs. 1000 off a first order', 'FIXED', 1000, 3000, array['CARD']::text[], true, 1, false, false, false, true),
  ('FREEDESSERT', 'Free delivery for demonstrations', 'FREE_DELIVERY', 0, 0, array['COD']::text[], false, null, true, true, false, true)
on conflict (code) do update set
  description = excluded.description,
  discount_type = excluded.discount_type,
  discount_value = excluded.discount_value,
  minimum_order = excluded.minimum_order,
  allowed_payment_methods = excluded.allowed_payment_methods,
  first_order_only = excluded.first_order_only,
  per_user_limit = excluded.per_user_limit,
  free_delivery = excluded.free_delivery,
  cod_applicable = excluded.cod_applicable,
  can_stack = excluded.can_stack,
  active = excluded.active;

-- 5. Force PostgREST to reload its schema cache immediately
notify pgrst, 'reload schema';
