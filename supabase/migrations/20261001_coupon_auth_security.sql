alter table coupons
  add column if not exists allowed_payment_methods text[] not null default '{}'::text[];

update coupons
set allowed_payment_methods = case
  when code in ('CAKE50', 'FIRSTCAKE') then array['CARD']::text[]
  when code in ('CAKE30', 'SAVE500', 'FREEDESSERT') then array['COD']::text[]
  when cod_applicable = false then array['CARD']::text[]
  else array[]::text[]
end;

update coupons
set first_order_only = true, per_user_limit = 1
where code = 'FIRSTCAKE';

update coupons
set free_delivery = true
where code = 'FREEDESSERT' or discount_type = 'FREE_DELIVERY';

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
